mod git;
mod import;
mod scaffold;
mod server;
mod vault;
mod watch;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tokio::sync::broadcast;

/// Say something on stdout, and survive nobody listening.
///
/// `println!` **panics** when the pipe is closed — Rust sets `SIGPIPE` to
/// `SIG_IGN` at startup, so the write returns `EPIPE` and the macro turns that
/// into `failed printing to stdout: Broken pipe`, which unwinds out of `main`
/// and takes the server with it. A serving process must not die because nobody
/// is reading its console: `register serve … | head -1`, a supervisor that
/// stopped draining, or a test that reads the banner and drops the pipe are all
/// ordinary, and none of them is a reason to stop answering requests.
///
/// Found the hard way. A second banner line — printed only when the host looks
/// shared, which is true on a CI runner and false on a laptop — killed seventeen
/// servers on the runner and none here, and the panic it produced was sitting in
/// the log being read as noise for three rounds.
macro_rules! say {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stdout(), $($arg)*);
    }};
}

/// How many events may queue for a client before it starts missing them. A
/// client that lags resyncs from `/api/tree` rather than stalling the vault.
const EVENT_BACKLOG: usize = 256;

/// REGISTER — a file-native second brain.
#[derive(Parser)]
#[command(name = "register", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve a vault as a local UI.
    Serve {
        /// Path to the vault folder.
        vault: PathBuf,
        /// Interface to bind.
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Port to bind.
        #[arg(long, default_value_t = 7777)]
        port: u16,
        /// Require this token from anything that is not localhost (§08 P12).
        ///
        /// Passing it here puts it in `ps` for every other user on the machine.
        /// Prefer `--token-file`, or the environment variable.
        #[arg(long, env = "REGISTER_TOKEN", hide_env_values = true)]
        token: Option<String>,
        /// Read the token from a file, so it never appears in argv.
        ///
        /// Deliberately no `conflicts_with`: clap counts an env-sourced value as
        /// present, so pairing it with `REGISTER_TOKEN` would make the two safe
        /// routes refuse to run together — and anyone with the variable exported
        /// in their shell could never use `--token-file` at all. Precedence is
        /// resolved in `read_token` instead: the file wins.
        #[arg(long, value_name = "FILE")]
        token_file: Option<PathBuf>,
        /// Bind a non-loopback address with no token.
        ///
        /// Refused by default: the origin guard's Host check is a browser
        /// integrity signal, not a credential, so a tokenless port on a network
        /// is readable and writable by anyone who can reach it. Pass this only
        /// when something else already limits that — a container whose port is
        /// published to loopback, or a firewall.
        #[arg(long)]
        allow_tokenless_network: bool,
        /// Serve the UI from this directory instead of the copy built into the
        /// binary. For working on the UI: `--assets app/dist` means a
        /// `pnpm build` is enough, with no reinstall.
        #[arg(long, value_name = "DIR")]
        assets: Option<PathBuf>,
        /// Also accept requests from this origin, for `pnpm dev`.
        ///
        /// The guard otherwise accepts only the origin the app is served from.
        /// It used to accept any loopback origin so vite could proxy from
        /// another port — which gave the same authority to every other web
        /// server on the machine, so a page open in a tab on
        /// `http://localhost:3000` could read, write and delete the vault. A
        /// hole in every install to buy contributors a convenience; they pass
        /// this instead. Example: `--dev-origin http://localhost:5173`.
        #[arg(long, value_name = "ORIGIN")]
        dev_origin: Option<String>,
    },
    /// Scaffold a new vault.
    Init {
        /// Path to create the vault at.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Initialise a git repository in the vault.
        #[arg(long)]
        git: bool,
    },
    /// Create a note and print its path.
    New {
        /// Note title.
        title: String,
        /// The vault to create it in. Defaults to the current directory, which
        /// is what §08 P8 specifies — this only spares an agent a `cd` first.
        #[arg(long, value_name = "DIR")]
        vault: Option<PathBuf>,
    },
    /// Convert an Obsidian vault into this format (§12).
    ///
    /// One way. Nothing in the source vault is opened for writing.
    Import {
        /// The Obsidian vault to read.
        source: PathBuf,
        /// The vault to write into. Scaffolded if it does not hold one yet,
        /// and never overwritten — a path already present is left alone.
        vault: PathBuf,
        /// Print what would be written and write nothing.
        #[arg(long)]
        dry_run: bool,
    },
    /// Print health status.
    Health,
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Health => {
            say!("ok");
            ExitCode::SUCCESS
        }
        Command::Serve {
            vault,
            host,
            port,
            token,
            token_file,
            allow_tokenless_network,
            assets,
            dev_origin,
        } => match read_token(token, token_file.as_deref()) {
            Err(message) => {
                eprintln!("{message}");
                ExitCode::FAILURE
            }
            Ok(token) => {
                match serve(
                    vault,
                    &host,
                    port,
                    token,
                    allow_tokenless_network,
                    assets,
                    dev_origin,
                )
                .await
                {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("{message}");
                        ExitCode::FAILURE
                    }
                }
            }
        },
        Command::Init { path, git } => report(init(&path, git)),
        Command::New { title, vault } => report(create(&title, vault.as_deref())),
        Command::Import {
            source,
            vault,
            dry_run,
        } => report(import_vault(&source, &vault, dry_run)),
    }
}

/// Print an outcome the way §01 asks for: what happened, then what to do next.
fn report(outcome: Result<String, String>) -> ExitCode {
    match outcome {
        Ok(said) => {
            say!("{said}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

/// The token, from whichever of the three routes was used.
///
/// A file is the one that leaks nothing: argv is world-readable through `ps`,
/// and an environment variable is readable from `/proc/<pid>/environ` on Linux
/// by the same user. The file wins when both are given, because it is the most
/// deliberate of the three — nobody sets `--token-file` by accident, while
/// `REGISTER_TOKEN` can be inherited from a shell nobody is thinking about.
///
/// Trailing newline trimmed, because every editor and every `openssl rand … >
/// file` puts one there and a token that differs by one byte fails in a way
/// nothing explains.
fn read_token(token: Option<String>, file: Option<&Path>) -> Result<Option<String>, String> {
    let resolved = match file {
        None => token,
        Some(file) => {
            let raw = std::fs::read_to_string(file)
                .map_err(|error| format!("token file {}: {error}", file.display()))?;
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                // Silently serving an unguarded vault because the file was empty
                // is the one outcome nobody would notice.
                return Err(format!("token file {} is empty", file.display()));
            }
            // Interior whitespace is the two-line file: it trims to something no
            // header, cookie or query string can carry, so the server would
            // start, announce remote mode, and refuse every credential anyone
            // can actually send.
            if trimmed.chars().any(char::is_whitespace) {
                return Err(format!(
                    "token file {} has whitespace inside the token; it must be one word",
                    file.display()
                ));
            }
            Some(trimmed.to_owned())
        }
    };

    // Whichever of the three routes it arrived by. A flag and an environment
    // variable are exactly as capable of holding `hunter2` as a file is.
    match resolved {
        None => Ok(None),
        Some(token) => {
            check_strength(&token)?;
            Ok(Some(token))
        }
    }
}

/// The shortest token worth calling one.
///
/// There is no rate limiting — a request costs the server almost nothing, so a
/// peer that can reach the port can guess as fast as the network allows. That
/// makes length the only thing standing between a token and a dictionary, so a
/// short one is refused rather than quietly accepted. 16 characters is about
/// what `openssl rand -hex 8` gives; the README suggests three times that.
const MIN_TOKEN: usize = 16;

fn check_strength(token: &str) -> Result<(), String> {
    if token.chars().count() < MIN_TOKEN {
        return Err(format!(
            "that token is {} characters; {MIN_TOKEN} is the minimum.\n\
             Nothing rate-limits guesses, so length is the whole defence:\n\
             \n    openssl rand -hex 24",
            token.chars().count()
        ));
    }
    Ok(())
}

fn init(path: &Path, git: bool) -> Result<String, String> {
    let made = scaffold::init(path, git).map_err(|error| format!("init: {error}"))?;
    let root = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string();

    let mut lines = vec![format!("register · vault {root}")];
    for rel in &made.created {
        lines.push(format!("  + {rel}"));
    }
    // Said out loud, because "it did nothing" and "it silently overwrote your
    // contract" look identical otherwise.
    for rel in &made.kept {
        lines.push(format!("  = {rel} (kept)"));
    }
    for note in &made.notes {
        lines.push(format!("  ! {note}"));
    }
    lines.push(format!("next: register serve {root}"));
    Ok(lines.join("\n"))
}

/// Convert an Obsidian vault into a §04 one (§12's importers row).
///
/// The source is opened read-only and the destination is scaffolded if it does
/// not hold a vault yet — the same rule `serve` applies, so importing into an
/// empty folder works without a separate `init`.
fn import_vault(source: &Path, root: &Path, dry_run: bool) -> Result<String, String> {
    if !source.is_dir() {
        return Err(format!("{} is not a folder", source.display()));
    }
    let read =
        import::read(source).map_err(|error| format!("read {}: {error}", source.display()))?;
    if read.notes.is_empty() {
        return Err(format!("{} holds no markdown notes", source.display()));
    }

    // Refusing to import a vault into itself, because the walk and the writes
    // would be reading and writing the same tree — and because the source is
    // meant to still be there afterwards.
    if same_folder(source, root) {
        return Err("the source and the destination are the same folder".to_owned());
    }

    if !dry_run && !scaffold::holds_a_vault(root) {
        scaffold::init(root, false).map_err(|error| format!("init {}: {error}", root.display()))?;
    }

    // A dry run still needs somewhere to start counting refs from. An absent
    // vault starts at the same place `init` would leave it.
    let vault = if dry_run && !scaffold::holds_a_vault(root) {
        None
    } else {
        Some(
            vault::Vault::open(root)
                .map_err(|error| format!("open {}: {error}", root.display()))?,
        )
    };
    let first = match &vault {
        Some(vault) => vault
            .next_ref()
            .map_err(|error| format!("allocate a ref: {error}"))?,
        None => "001".to_owned(),
    };

    // What the vault already holds, so a second import is not a second copy.
    let taken = vault.as_ref().map_or_else(Default::default, |vault| {
        vault
            .paths()
            .unwrap_or_default()
            .iter()
            .filter_map(|rel| import::identity_of_existing(rel))
            .collect()
    });
    let outcome = import::plan(&read, &first, &taken);
    let summary = import::summary(&outcome);

    if dry_run {
        say!("{}", import::report(&outcome));
        return Ok(format!("{summary} Nothing written (--dry-run)."));
    }

    let Some(vault) = vault else {
        return Err("the destination vault could not be opened".to_owned());
    };
    let written =
        import::apply(&vault, source, &outcome).map_err(|error| format!("import: {error}"))?;

    // The report is written last, so it describes an import that finished.
    let reference = vault
        .next_ref()
        .map_err(|error| format!("allocate a ref: {error}"))?;
    let rel = format!("notes/{reference}-import-report.md");
    let body = scaffold::note(
        &reference,
        "Import report",
        &["import"],
        &import::report(&outcome),
        std::time::SystemTime::now(),
        std::time::SystemTime::now(),
        None,
    );
    vault
        .write(&rel, &body, None)
        .map_err(|error| format!("write {rel}: {error}"))?;

    Ok(format!("{summary} {written} files written. See {rel}"))
}

/// Whether two paths name the same directory, canonicalised so `.` and a
/// symlink cannot smuggle one past the other.
fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        // An unresolvable destination has not been created yet, so it cannot be
        // the source.
        _ => false,
    }
}

fn create(title: &str, at: Option<&Path>) -> Result<String, String> {
    // Named, or the current directory. The default is §08 P8's specification and
    // does not move; `--vault` exists because an agent scripting note creation
    // had to `cd` first, and a `cd` inside a script is a state change that
    // outlives the command that needed it.
    let root = match at {
        Some(path) => path.to_path_buf(),
        None => scaffold::here().map_err(|error| format!("current directory: {error}"))?,
    };
    // A vault is marked by the directory the app owns. Without this check a
    // mistyped `cd` — or a mistyped `--vault` — scatters notes into whatever
    // folder was named.
    if !root.join(vault::APP_DIR).is_dir() {
        return Err(format!(
            "{} is not a REGISTER vault. `register init` creates one.",
            root.display()
        ));
    }

    let vault =
        vault::Vault::open(&root).map_err(|error| format!("open {}: {error}", root.display()))?;
    scaffold::create(&vault, title).map_err(|error| format!("new: {error}"))
}

/// Does this machine plausibly have other people on it?
///
/// A weak signal by construction — there is no portable way to ask "am I alone
/// here" — so it errs towards silence. More than one real home directory is the
/// cheapest thing that distinguishes a laptop from a shared box, and being wrong
/// costs one extra line on a server or one missing line at home. It never fails
/// the start: a machine whose home directory root cannot be read is a machine
/// this has nothing to say about.
fn shared_host() -> bool {
    #[cfg(unix)]
    {
        let root = if cfg!(target_os = "macos") {
            "/Users"
        } else {
            "/home"
        };
        let Ok(entries) = std::fs::read_dir(root) else {
            return false;
        };
        entries
            .flatten()
            .filter(|entry| {
                // `Shared`, `.localized` and the like are not people.
                let name = entry.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.')
                    && name != "Shared"
                    && entry.file_type().is_ok_and(|kind| kind.is_dir())
            })
            .count()
            > 1
    }
    #[cfg(not(unix))]
    {
        false
    }
}

async fn serve(
    root: PathBuf,
    host: &str,
    port: u16,
    token: Option<String>,
    allow_tokenless_network: bool,
    assets: Option<PathBuf>,
    dev_origin: Option<String>,
) -> Result<(), String> {
    // Argument validation first, before anything binds a port or prints a
    // banner. A refusal that follows "register · vault … · http://…" reads as a
    // server that started and then died, which is a different bug from the one
    // that happened.
    if let Some(dir) = assets.as_deref()
        && !dir.is_dir()
    {
        return Err(format!("assets {}: not a directory", dir.display()));
    }

    // Pointing the app at a folder is the whole of setup.
    //
    // Before this, `serve` on a folder with no vault in it started cleanly and
    // served an empty one: no agent contract, no daily stencil, no inbox — so
    // `G D` and NEW FROM TEMPLATE had nothing to cut from and the §04 premise
    // was quietly absent, on a screen that looked fine. A missing folder was
    // worse: `open: no such note`, which tells a beginner nothing at all. Both
    // are the same instruction — run `register init` first — that nothing on
    // screen ever gave.
    //
    // Only ever into a folder holding no vault (`holds_a_vault`), and `init`
    // itself never overwrites, so this cannot touch anybody's notes. Said out
    // loud rather than done silently, because a command that writes files
    // should say which ones.
    if !scaffold::holds_a_vault(&root) {
        let made = scaffold::init(&root, false)
            .map_err(|error| format!("init {}: {error}", root.display()))?;
        for rel in &made.created {
            say!("  + {rel}");
        }
        for note in &made.notes {
            say!("  ! {note}");
        }
    }

    let vault =
        vault::Vault::open(&root).map_err(|error| format!("serve {}: {error}", root.display()))?;
    let vault = Arc::new(vault);

    // Before anything else starts: the watcher, the checkpointer and the
    // listener all belong to whichever process holds the vault, and starting
    // them first would mean tearing them down again to refuse.
    let claim = vault.claim().map_err(|error| error.to_string())?;

    let (events, _first) = broadcast::channel(EVENT_BACKLOG);

    // Bound to the lifetime of this function on purpose. Dropping a notify
    // watcher stops delivery silently — no error, no closed channel, just a
    // server that never notices an agent again.
    let _watch = watch::Watch::start(vault.clone(), events.clone())
        .map_err(|error| format!("watch {}: {error}", vault.root().display()))?;

    let listener = server::listener(host, port)
        .await
        .map_err(|error| format!("bind {host}:{port}: {error}"))?;
    let addr = server::local_addr(&listener).map_err(|error| error.to_string())?;

    // Before the banner, so a refusal never follows a line announcing the very
    // thing being refused.
    //
    // Fail closed on the one signal that cannot be forged: the address actually
    // bound. The origin guard's first test reads the `Host` *request header*,
    // which is chosen by the client — it stops DNS rebinding, because a browser
    // cannot lie about it, and stops nothing at all from `curl`. Measured on a
    // tokenless `--host 0.0.0.0`: one `-H 'Host: localhost'` and a LAN peer had
    // read, write and delete on the whole vault.
    if !addr.ip().is_loopback() && token.is_none() && !allow_tokenless_network {
        let where_ = vault.root().display();
        return Err(format!(
            "refusing to serve {where_} on {addr} without a token.

Anything that can reach this port needs only a `Host: localhost` header to pass
the origin guard, and that header is chosen by the client — it is not a
credential. Give it a real one:

    openssl rand -hex 24 > ~/.register-token
    register serve {where_} --host {host} --token-file ~/.register-token

If something else already decides who can reach this port — a container
published to loopback, a firewall — then say so explicitly:

    --allow-tokenless-network"
        ));
    }

    say!(
        "register · vault {} · http://{addr}",
        vault.root().display()
    );

    // Said out loud: this is the one mode where what you are looking at is not
    // what the binary would ship.
    if let Some(dir) = assets.as_deref() {
        say!(
            "register · serving the UI from {} (not the built-in copy)",
            dir.display()
        );
    }

    // Checkpoints run off the same event stream the UI does, so they see
    // exactly what the watcher saw — and they are off unless the vault's own
    // config asks for them (§08 P12).
    let _checkpoints = git::Checkpointer::start(vault.clone(), events.subscribe());

    let state = server::AppState::new(vault, events)
        .bound_to(addr)
        .with_token(token)
        .with_assets(assets)
        .with_dev_origin(dev_origin.clone());
    if let Some(origin) = dev_origin.as_deref() {
        say!("register · also accepting requests from {origin}");
    }
    if state.guarded() {
        say!("register · remote mode: a token is required from anything but localhost");
    } else if !addr.ip().is_loopback() {
        say!(
            "register · WARNING: serving {addr} with no token. Anything that can reach \
             this port can read and write the vault."
        );
    } else if shared_host() {
        // Loopback is trusted as the vault's owner, which is right on your own
        // machine and is what makes `register serve ~/vault` the whole of setup.
        // On a shared host it is not: every other account can reach 127.0.0.1,
        // so they get read, write and delete on a vault whose mode 700 is
        // keeping them out at the filesystem level — the app handing over what
        // the filesystem denies. Said here rather than only in SECURITY.md,
        // because the people this reaches will never read a file in the repo.
        say!(
            "register · note: any account on this machine can reach {addr}. \
             On a shared host, start with --token."
        );
    }
    server::serve(listener, state)
        .await
        .map_err(|error| error.to_string())?;
    // Explicit, so the claim's release is a statement rather than a side effect
    // of where a binding happened to be declared.
    drop(claim);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_token;
    use std::path::PathBuf;

    /// A scratch file path unique to this process and call site.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("register-token-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join(name)
    }

    #[test]
    fn no_file_means_the_flag_or_the_environment_stands() {
        assert_eq!(read_token(None, None), Ok(None));
        let long = "from-argv-and-long-enough";
        assert_eq!(
            read_token(Some(long.to_owned()), None),
            Ok(Some(long.to_owned()))
        );
    }

    #[test]
    fn a_file_wins_over_the_flag_and_loses_its_trailing_newline() {
        let path = scratch("good.txt");
        std::fs::write(&path, "s3cret-and-long-enough\n").expect("write");
        assert_eq!(
            read_token(Some("from-argv-and-long-enough".to_owned()), Some(&path)),
            Ok(Some("s3cret-and-long-enough".to_owned()))
        );
    }

    #[test]
    fn an_unusable_file_is_refused_and_names_itself() {
        let empty = scratch("empty.txt");
        std::fs::write(&empty, "").expect("write");
        let blank = scratch("blank.txt");
        std::fs::write(&blank, "  \n\n").expect("write");
        let two = scratch("two.txt");
        std::fs::write(&two, "line1\nline2\n").expect("write");
        let missing = scratch("nope.txt");
        let _ = std::fs::remove_file(&missing);

        for (path, expect) in [
            (&empty, "is empty"),
            (&blank, "is empty"),
            (&two, "whitespace inside"),
            (&missing, "token file"),
        ] {
            let error = read_token(None, Some(path)).expect_err("should refuse");
            assert!(error.contains(expect), "{path:?}: {error}");
            // Whatever went wrong, the message says which file to go and look at.
            assert!(
                error.contains(&path.display().to_string()),
                "{path:?}: {error}"
            );
        }
    }

    /// Nothing rate-limits a guess, so a short token is not a weak secret — it
    /// is no secret. Every route in must be checked, not only the file.
    #[test]
    fn a_short_token_is_refused_however_it_arrived() {
        let short = read_token(Some("hunter2".to_owned()), None).expect_err("should refuse");
        assert!(short.contains("minimum"), "{short}");
        assert!(short.contains("openssl rand"), "{short}");

        let path = scratch("short.txt");
        std::fs::write(&path, "hunter2\n").expect("write");
        let from_file = read_token(None, Some(&path)).expect_err("should refuse");
        assert!(from_file.contains("minimum"), "{from_file}");

        // And no token at all is still the ordinary local case.
        assert_eq!(read_token(None, None), Ok(None));
    }
}
