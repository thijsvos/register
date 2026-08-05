use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

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

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Health => {
            println!("ok");
            ExitCode::SUCCESS
        }
        Command::Serve { vault, host, port } => {
            stub(&format!("serve {} on {host}:{port}", vault.display()))
        }
        Command::Init { path, git } => stub(&format!("init {} (git: {git})", path.display())),
        Command::New { title } => stub(&format!("new {title:?}")),
    }
}

/// Report an unimplemented subcommand. Stubs fail loudly; only `health` succeeds.
fn stub(what: &str) -> ExitCode {
    eprintln!("{what}: not implemented");
    ExitCode::FAILURE
}
