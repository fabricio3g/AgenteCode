//! Entry point. Parses the few arguments the desktop app takes, mirroring the
//! CLI surface the TUI has for resuming a session.

fn main() {
    let mut resume: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--resume" | "-r" => {
                // Bare `--resume` opens the picker; a value resumes that id.
                resume = Some(args.next().unwrap_or_default());
            }
            "--help" | "-h" => {
                println!(
                    "agente-desktop-egui — Agente Desktop (egui)\n\n\
                     Usage:\n  \
                     agente-desktop-egui [--resume [<session-id|prefix>]]\n\n\
                     Environment:\n  \
                     AGENTE_EGUI_SCREENSHOT=/path/out.png  write a screenshot and exit\n  \
                     AGENTE_EGUI_THEME=dark|light          pin the theme for that run\n"
                );
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    if let Err(err) = desktop_egui::app::run(resume) {
        eprintln!("[desktop-egui] failed to start: {err}");
        std::process::exit(1);
    }
}
