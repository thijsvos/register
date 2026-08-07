mod git;
mod scaffold;
mod server;
mod vault;
mod watch;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tokio::sync::broadcast;

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
    },
    /// Print health status.
    Health,
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Health => {
            println!("ok");
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
        } => match read_token(token, token_file.as_deref()) {
            Err(message) => {
                eprintln!("{message}");
                ExitCode::FAILURE
            }
            Ok(token) => {
                match serve(vault, &host, port, token, allow_tokenless_network, assets).await {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(message) => {
                        eprintln!("{message}");
                        ExitCode::FAILURE
                    }
                }
            }
        },
        Command::Init { path, git } => report(init(&path, git)),
        Command::New { title } => report(create(&title)),
    }
}

/// Print an outcome the way §01 asks for: what happened, then what to do next.
fn report(outcome: Result<String, String>) -> ExitCode {
    match outcome {
        Ok(said) => {
            println!("{said}");
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

fn create(title: &str) -> Result<String, String> {
    let root = scaffold::here().map_err(|error| format!("current directory: {error}"))?;
    // A vault is marked by the directory the app owns. Without this check a
    // mistyped `cd` scatters notes into whatever folder happened to be current.
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

async fn serve(
    root: PathBuf,
    host: &str,
    port: u16,
    token: Option<String>,
    allow_tokenless_network: bool,
    assets: Option<PathBuf>,
) -> Result<(), String> {
    let vault =
        vault::Vault::open(&root).map_err(|error| format!("serve {}: {error}", root.display()))?;
    let vault = Arc::new(vault);

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

    println!(
        "register · vault {} · http://{addr}",
        vault.root().display()
    );

    // Checkpoints run off the same event stream the UI does, so they see
    // exactly what the watcher saw — and they are off unless the vault's own
    // config asks for them (§08 P12).
    let _checkpoints = git::Checkpointer::start(vault.clone(), events.subscribe());

    // The bound address decides whether /api/reveal is available at all.
    if let Some(dir) = assets.as_deref() {
        if !dir.is_dir() {
            return Err(format!("assets {}: not a directory", dir.display()));
        }
        // Said out loud: this is the one mode where what you are looking at is
        // not what the binary would ship.
        println!(
            "register · serving the UI from {} (not the built-in copy)",
            dir.display()
        );
    }

    let state = server::AppState::new(vault, events)
        .bound_to(addr)
        .with_token(token)
        .with_assets(assets);
    if state.guarded() {
        println!("register · remote mode: a token is required from anything but localhost");
    } else if !addr.ip().is_loopback() {
        println!(
            "register · WARNING: serving {addr} with no token. Anything that can reach \
             this port can read and write the vault."
        );
    }
    server::serve(listener, state)
        .await
        .map_err(|error| error.to_string())
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
