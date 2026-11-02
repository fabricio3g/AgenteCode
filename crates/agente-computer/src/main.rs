//! Private stdio input helper. No network, shell, screenshots or persisted data.
#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    if let Err(error) = windows::run() {
        eprintln!("Computer control: {error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Computer control is currently available on Windows only.");
        std::process::exit(1);
    }
}
