use agente_audio::{analyze, paint, read_wav, render, write_wav, Graph, SpectralPaint};
use anyhow::{bail, Context, Result};
use serde_json::json;
#[cfg(feature = "devices")]
use std::io::{self, BufRead};
use std::path::Path;

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") => println!("agente-audio {}", env!("CARGO_PKG_VERSION")),
        Some("capabilities") => println!("{}", json!({ "version": 1, "devices": cfg!(feature = "devices"), "render": true, "spectralPaint": true })),
        Some("analyze") => { let input = args.get(2).context("Missing WAV path")?; println!("{}", serde_json::to_string(&analyze(&read_wav(Path::new(input))?))?); }
        Some("render") => {
            let input = args.get(2).context("Missing graph JSON")?; let output = args.get(3).context("Missing output WAV")?;
            let graph: Graph = serde_json::from_slice(&std::fs::read(input)?)?; write_wav(Path::new(output), &render(&graph)?)?;
            println!("{}", json!({ "output": output }));
        }
        Some("paint") => {
            let input = args.get(2).context("Missing spectral canvas JSON")?; let output = args.get(3).context("Missing output WAV")?;
            let spec: SpectralPaint = serde_json::from_slice(&std::fs::read(input)?)?; write_wav(Path::new(output), &paint(&spec)?)?;
            println!("{}", json!({ "output": output, "method": "Griffin-Lim approximate phase reconstruction" }));
        }
        Some("play") => {
            let input = args.get(2).context("Missing WAV path")?;
            play(read_wav(Path::new(input))?)?;
        }
        _ => bail!("Use capabilities, analyze INPUT.wav, render GRAPH.json OUTPUT.wav, paint CANVAS.json OUTPUT.wav, or play INPUT.wav"),
    }
    Ok(())
}
#[cfg(not(feature = "devices"))]
fn play(_audio: agente_audio::Audio) -> Result<()> {
    bail!(
        "This engine was built without device support. Build agente-audio with --features devices."
    )
}
#[cfg(feature = "devices")]
fn play(audio: agente_audio::Audio) -> Result<()> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .context("No audio output device is available")?;
    let supported = device.default_output_config()?;
    let config: cpal::StreamConfig = supported.clone().into();
    let audio = Arc::new(audio);
    let position = Arc::new(AtomicUsize::new(0));
    let paused = Arc::new(AtomicBool::new(false));
    let looped = Arc::new(AtomicBool::new(false));
    let make_sample = {
        let audio = Arc::clone(&audio);
        let position = Arc::clone(&position);
        let paused = Arc::clone(&paused);
        let looped = Arc::clone(&looped);
        move || {
            if paused.load(Ordering::Relaxed) {
                return [0.0; 2];
            }
            let mut frame = position.fetch_add(1, Ordering::Relaxed);
            let source_frame = frame * audio.sample_rate as usize / config.sample_rate.0 as usize;
            if source_frame >= audio.frames() && looped.load(Ordering::Relaxed) {
                position.store(1, Ordering::Relaxed);
                frame = 0;
            }
            audio.stereo_at(frame * audio.sample_rate as usize / config.sample_rate.0 as usize)
        }
    };
    let channels = usize::from(config.channels);
    let on_error = |error| eprintln!("Audio device error: {error}");
    macro_rules! output {
        ($type:ty) => {{
            let next = make_sample;
            device.build_output_stream(
                &config,
                move |data: &mut [$type], _| {
                    for frame in data.chunks_mut(channels) {
                        let pair = next();
                        for (ch, sample) in frame.iter_mut().enumerate() {
                            *sample =
                                <$type as cpal::FromSample<f32>>::from_sample_(pair[ch.min(1)]);
                        }
                    }
                },
                on_error,
                None,
            )?
        }};
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => output!(f32),
        cpal::SampleFormat::I16 => output!(i16),
        cpal::SampleFormat::U16 => output!(u16),
        _ => bail!("Unsupported device sample format"),
    };
    stream.play()?;
    println!(
        "{}",
        json!({"state": "playing", "device": device.name()?, "sampleRate": config.sample_rate.0, "channels": config.channels})
    );
    for line in io::stdin().lock().lines() {
        let command: serde_json::Value = serde_json::from_str(&line?)?;
        match command["action"].as_str() {
            Some("stop") => break,
            Some("pause") => paused.store(true, Ordering::Relaxed),
            Some("resume") => paused.store(false, Ordering::Relaxed),
            Some("loop") => looped.store(
                command["enabled"].as_bool().unwrap_or(false),
                Ordering::Relaxed,
            ),
            Some("seek") => position.store(
                (command["time"].as_f64().unwrap_or(0.0).max(0.0) * f64::from(config.sample_rate.0))
                    as usize,
                Ordering::Relaxed,
            ),
            Some("position") => println!(
                "{}",
                json!({"time": position.load(Ordering::Relaxed) as f64 / f64::from(config.sample_rate.0)})
            ),
            _ => {}
        }
    }
    drop(stream);
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
