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
        Command::Serve { vault, host, port } => match serve(vault, &host, port).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("{message}");
                ExitCode::FAILURE
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

async fn serve(root: PathBuf, host: &str, port: u16) -> Result<(), String> {
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
    println!(
        "register · vault {} · http://{addr}",
        vault.root().display()
    );

    // The bound address decides whether /api/reveal is available at all.
    let state = server::AppState::new(vault, events).bound_to(addr);
    server::serve(listener, state)
        .await
        .map_err(|error| error.to_string())
}
