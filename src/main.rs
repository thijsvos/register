mod server;
mod vault;
mod watch;

use std::path::PathBuf;
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
        Command::Init { path, git } => stub(&format!("init {} (git: {git})", path.display())),
        Command::New { title } => stub(&format!("new {title:?}")),
    }
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

    let state = server::AppState::new(vault, events);
    server::serve(listener, state)
        .await
        .map_err(|error| error.to_string())
}

/// Report an unimplemented subcommand. Stubs fail loudly; only `health` and
/// `serve` are live before P8.
fn stub(what: &str) -> ExitCode {
    eprintln!("{what}: not implemented");
    ExitCode::FAILURE
}
