//! One graph for offline rendering and native playback. No agent work runs in the audio callback.
use anyhow::{bail, Context, Result};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub path: String,
    pub start: f64,
    pub offset: f64,
    pub duration: f64,
    pub gain_db: f32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub pitch: u8,
    pub start: f64,
    pub duration: f64,
    pub velocity: f32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub waveform: String,
    pub attack: f64,
    pub release: f64,
    pub sample_path: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub time: f64,
    pub value: f32,
}
#[derive(Clone, Deserialize, Default)]
pub struct Automation {
    #[serde(default)]
    pub gain: Vec<Point>,
    #[serde(default)]
    pub pan: Vec<Point>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Send {
    pub track_id: String,
    pub gain_db: f32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: String,
    pub gain_db: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub notes: Vec<Note>,
    pub instrument: Option<Instrument>,
    pub output: Option<String>,
    #[serde(default)]
    pub sends: Vec<Send>,
    #[serde(default)]
    pub automation: Automation,
    #[serde(default)]
    pub effects: Vec<Effect>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub sample_rate: u32,
    pub tracks: Vec<Track>,
}
#[derive(Clone)]
pub struct Audio {
    pub sample_rate: u32,
    pub channels: usize,
    pub samples: Vec<f32>,
}
impl Audio {
    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels
    }
    pub fn stereo_at(&self, frame: usize) -> [f32; 2] {
        if frame >= self.frames() {
            return [0.0; 2];
        }
        let i = frame * self.channels;
        [
            self.samples[i],
            self.samples[i + usize::from(self.channels > 1)],
        ]
    }
}
pub fn read_wav(path: &Path) -> Result<Audio> {
    if std::fs::metadata(path)?.len() > 256 * 1024 * 1024 {
        bail!("Decode a region shorter than 256 MB for this audio worker");
    }
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("Open {}", path.display()))?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.sample_rate == 0 {
        bail!("Invalid WAV format");
    }
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let divisor = 2_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|v| v as f32 / divisor))
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    if samples.iter().any(|s| !s.is_finite()) {
        bail!("Audio contains non-finite samples");
    }
    Ok(Audio {
        sample_rate: spec.sample_rate,
        channels: usize::from(spec.channels),
        samples,
    })
}
pub fn write_wav(path: &Path, audio: &Audio) -> Result<()> {
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: audio.channels as u16,
            sample_rate: audio.sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )?;
    for &sample in &audio.samples {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;
    Ok(())
}
fn db(value: f32) -> f32 {
    10_f32.powf(value / 20.0)
}
fn automate(points: &[Point], time: f64, fallback: f32) -> f32 {
    if points.is_empty() {
        return fallback;
    }
    if time <= points[0].time {
        return points[0].value;
    }
    for pair in points.windows(2) {
        if time < pair[1].time {
            let span = pair[1].time - pair[0].time;
            let ratio = if span > 0.0 {
                ((time - pair[0].time) / span) as f32
            } else {
                1.0
            };
            return pair[0].value + ratio * (pair[1].value - pair[0].value);
        }
    }
    points.last().map_or(fallback, |p| p.value)
}
fn oscillator(wave: &str, phase: f64) -> f32 {
    let phase = phase.fract();
    match wave {
        "square" => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        "saw" => (phase * 2.0 - 1.0) as f32,
        "triangle" => (1.0 - 4.0 * (phase - 0.5).abs()) as f32,
        _ => (phase * std::f64::consts::TAU).sin() as f32,
    }
}
pub fn render(graph: &Graph) -> Result<Audio> {
    if !(8000..=192000).contains(&graph.sample_rate) {
        bail!("Unsupported sample rate");
    }
    if graph.tracks.len() > 256 {
        bail!("Too many tracks");
    }
    let rate = f64::from(graph.sample_rate);
    let duration = graph
        .tracks
        .iter()
        .flat_map(|t| {
            t.clips.iter().map(|c| c.start + c.duration).chain(
                t.notes.iter().map(|n| {
                    n.start + n.duration + t.instrument.as_ref().map_or(0.1, |i| i.release)
                }),
            )
        })
        .fold(0_f64, f64::max);
    if !duration.is_finite() || !(0.0..=1800.0).contains(&duration) {
        bail!("Render a region of at most 30 minutes");
    }
    let frames = (duration * rate).ceil() as usize;
    if frames
        .saturating_mul(8)
        .saturating_mul(graph.tracks.len() + 1)
        > 512 * 1024 * 1024
    {
        bail!("This render exceeds the 512 MB worker budget. Render a shorter region or fewer tracks.");
    }
    let mut buffers: HashMap<String, Vec<f32>> = HashMap::new();
    let solo = graph.tracks.iter().any(|t| t.solo);
    let mut cache = HashMap::<String, Audio>::new();
    for track in &graph.tracks {
        if buffers.contains_key(&track.id) {
            bail!("Duplicate track IDs");
        }
        let mut output = vec![0.0; frames * 2];
        if !track.mute && (!solo || track.solo || track.kind == "bus") {
            for clip in &track.clips {
                if ![clip.start, clip.offset, clip.duration]
                    .iter()
                    .all(|v| v.is_finite() && *v >= 0.0)
                {
                    bail!("Invalid clip bounds");
                }
                if !cache.contains_key(&clip.path) {
                    cache.insert(clip.path.clone(), read_wav(Path::new(&clip.path))?);
                }
                let input = &cache[&clip.path];
                for n in 0..(clip.duration * rate).ceil() as usize {
                    let destination = (clip.start * rate) as usize + n;
                    if destination >= frames {
                        break;
                    }
                    let source =
                        ((clip.offset + n as f64 / rate) * f64::from(input.sample_rate)) as usize;
                    let pair = input.stereo_at(source);
                    for ch in 0..2 {
                        output[destination * 2 + ch] += pair[ch] * db(clip.gain_db);
                    }
                }
            }
            if let Some(instrument) = &track.instrument {
                let sample = instrument
                    .sample_path
                    .as_ref()
                    .map(|p| read_wav(Path::new(p)))
                    .transpose()?;
                for note in &track.notes {
                    let frequency = 440.0 * 2_f64.powf((f64::from(note.pitch) - 69.0) / 12.0);
                    for n in 0..((note.duration + instrument.release) * rate) as usize {
                        let dest = (note.start * rate) as usize + n;
                        if dest >= frames {
                            break;
                        }
                        let time = n as f64 / rate;
                        let attack = if instrument.attack > 0.0 {
                            (time / instrument.attack).min(1.0)
                        } else {
                            1.0
                        };
                        let release = if time > note.duration {
                            if instrument.release > 0.0 {
                                (1.0 - (time - note.duration) / instrument.release).max(0.0)
                            } else {
                                0.0
                            }
                        } else {
                            1.0
                        };
                        let pair = sample.as_ref().map_or_else(
                            || [oscillator(&instrument.waveform, time * frequency); 2],
                            |audio| {
                                audio.stereo_at(
                                    (time * f64::from(audio.sample_rate) * frequency / 440.0)
                                        as usize,
                                )
                            },
                        );
                        for ch in 0..2 {
                            output[dest * 2 + ch] +=
                                pair[ch] * (attack * release) as f32 * note.velocity * 0.2;
                        }
                    }
                }
            }
        }
        buffers.insert(track.id.clone(), output);
    }
    let tracks: HashMap<_, _> = graph.tracks.iter().map(|t| (t.id.clone(), t)).collect();
    let mut processed = HashSet::new();
    let mut visiting = HashSet::new();
    let mut master = vec![0.0; frames * 2];
    fn route(
        id: &str,
        tracks: &HashMap<String, &Track>,
        buffers: &mut HashMap<String, Vec<f32>>,
        processed: &mut HashSet<String>,
        visiting: &mut HashSet<String>,
        master: &mut [f32],
        rate: f64,
    ) -> Result<()> {
        if processed.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_owned()) {
            bail!("Audio routing contains a cycle");
        }
        // Every source that feeds this track must be applied first.
        for source in tracks
            .values()
            .filter(|t| t.output.as_deref() == Some(id) || t.sends.iter().any(|s| s.track_id == id))
        {
            route(
                &source.id, tracks, buffers, processed, visiting, master, rate,
            )?;
        }
        let track = tracks[id];
        let mut audio = buffers.remove(id).context("Missing routed track")?;
        apply_effects(&mut audio, rate as u32, &track.effects);
        for (n, pair) in audio.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let time = n as f64 / rate;
            let gain = if track.mute {
                0.0
            } else {
                db(automate(&track.automation.gain, time, track.gain_db))
            };
            let pan = automate(&track.automation.pan, time, track.pan).clamp(-1.0, 1.0);
            pair[0] *= gain * if pan > 0.0 { 1.0 - pan } else { 1.0 };
            pair[1] *= gain * if pan < 0.0 { 1.0 + pan } else { 1.0 };
        }
        for send in &track.sends {
            let destination = buffers
                .get_mut(&send.track_id)
                .context("Missing send bus")?;
            for (dest, source) in destination.iter_mut().zip(&audio) {
                *dest += *source * db(send.gain_db);
            }
        }
        if let Some(output) = &track.output {
            let destination = buffers.get_mut(output).context("Missing output bus")?;
            for (dest, source) in destination.iter_mut().zip(&audio) {
                *dest += source;
            }
        } else {
            for (dest, source) in master.iter_mut().zip(&audio) {
                *dest += source;
            }
        }
        buffers.insert(id.to_owned(), audio);
        visiting.remove(id);
        processed.insert(id.to_owned());
        Ok(())
    }
    for id in tracks.keys() {
        route(
            id,
            &tracks,
            &mut buffers,
            &mut processed,
            &mut visiting,
            &mut master,
            rate,
        )?;
    }
    Ok(Audio {
        sample_rate: graph.sample_rate,
        channels: 2,
        samples: master,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralPoint {
    pub time: f64,
    pub frequency: f32,
    pub amplitude: f32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralPaint {
    pub duration: f64,
    pub sample_rate: u32,
    pub points: Vec<SpectralPoint>,
    pub seed: u64,
    pub iterations: usize,
}
/// Griffin-Lim phase reconstruction of a painted STFT magnitude field.
pub fn paint(spec: &SpectralPaint) -> Result<Audio> {
    if !(0.01..=60.0).contains(&spec.duration)
        || !(8000..=96000).contains(&spec.sample_rate)
        || spec.points.len() > 10000
    {
        bail!("Invalid spectral canvas");
    }
    let size = 1024;
    let hop = size / 4;
    let frames = (spec.duration * f64::from(spec.sample_rate)).ceil() as usize;
    let windows = frames.div_ceil(hop) + 1;
    let bins = size / 2 + 1;
    let mut magnitudes = vec![vec![0_f32; bins]; windows];
    for point in &spec.points {
        if !point.time.is_finite()
            || point.time < 0.0
            || !point.frequency.is_finite()
            || point.frequency < 0.0
            || point.frequency > spec.sample_rate as f32 / 2.0
            || !point.amplitude.is_finite()
        {
            bail!("Invalid spectral point");
        }
        let time = (point.time * f64::from(spec.sample_rate) / hop as f64) as usize;
        let frequency = (point.frequency * size as f32 / spec.sample_rate as f32) as usize;
        for dt in -2_i32..=2 {
            for df in -2_i32..=2 {
                let t = time as i32 + dt;
                let f = frequency as i32 + df;
                if t >= 0 && f >= 0 && (t as usize) < windows && (f as usize) < bins {
                    magnitudes[t as usize][f as usize] += point.amplitude.clamp(0.0, 1.0)
                        * (-(dt * dt + df * df) as f32 / 3.0).exp()
                        * 100.0;
                }
            }
        }
    }
    let window: Vec<f32> = (0..size)
        .map(|n| 0.5 - 0.5 * (std::f32::consts::TAU * n as f32 / size as f32).cos())
        .collect();
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(size);
    let inverse = planner.plan_fft_inverse(size);
    let mut seed = spec.seed.max(1);
    let mut spectra = vec![vec![Complex::new(0.0, 0.0); size]; windows];
    for (spectrum, mag) in spectra.iter_mut().zip(&magnitudes) {
        for bin in 0..bins {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let phase = seed as f32 / u64::MAX as f32 * std::f32::consts::TAU;
            spectrum[bin] = Complex::from_polar(mag[bin], phase);
        }
    }
    let mut signal = vec![0.0_f32; frames + size];
    for _ in 0..spec.iterations.clamp(1, 64) {
        signal.fill(0.0);
        let mut weight = vec![0.0_f32; signal.len()];
        for (t, spectrum) in spectra.iter().enumerate() {
            let mut buffer = spectrum.clone();
            for bin in 1..size / 2 {
                buffer[size - bin] = buffer[bin].conj();
            }
            inverse.process(&mut buffer);
            for n in 0..size {
                let index = t * hop + n;
                if index < signal.len() {
                    signal[index] += buffer[n].re / size as f32 * window[n];
                    weight[index] += window[n] * window[n];
                }
            }
        }
        for (sample, weight) in signal.iter_mut().zip(weight) {
            if weight > 0.00001 {
                *sample /= weight;
            }
        }
        for (t, (spectrum, mag)) in spectra.iter_mut().zip(&magnitudes).enumerate() {
            let mut buffer: Vec<_> = (0..size)
                .map(|n| {
                    Complex::new(
                        signal.get(t * hop + n).copied().unwrap_or(0.0) * window[n],
                        0.0,
                    )
                })
                .collect();
            fft.process(&mut buffer);
            for bin in 0..bins {
                spectrum[bin] = Complex::from_polar(mag[bin], buffer[bin].arg());
            }
        }
    }
    signal.truncate(frames);
    let peak = signal.iter().copied().map(f32::abs).fold(0_f32, f32::max);
    if peak > 0.0 {
        for sample in &mut signal {
            *sample *= 0.7 / peak;
        }
    }
    Ok(Audio {
        sample_rate: spec.sample_rate,
        channels: 1,
        samples: signal,
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub duration: f64,
    pub channels: usize,
    pub peak: f32,
    pub rms: f32,
    pub clipped_samples: usize,
}
pub fn analyze(audio: &Audio) -> Analysis {
    let peak = audio
        .samples
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0_f32, f32::max);
    let rms = if audio.samples.is_empty() {
        0.0
    } else {
        (audio
            .samples
            .iter()
            .map(|v| f64::from(*v).powi(2))
            .sum::<f64>()
            / audio.samples.len() as f64)
            .sqrt() as f32
    };
    Analysis {
        duration: audio.frames() as f64 / f64::from(audio.sample_rate),
        channels: audio.channels,
        peak,
        rms,
        clipped_samples: audio.samples.iter().filter(|v| v.abs() >= 1.0).count(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn painted_spectrum_is_reproducible_and_finite() {
        let p = SpectralPaint {
            duration: 0.1,
            sample_rate: 8000,
            points: vec![SpectralPoint {
                time: 0.04,
                frequency: 500.0,
                amplitude: 0.5,
            }],
            seed: 7,
            iterations: 4,
        };
        let a = paint(&p).unwrap();
        let b = paint(&p).unwrap();
        assert_eq!(a.samples, b.samples);
        assert!(analyze(&a).peak > 0.0);
        assert!(a.samples.iter().all(|v| v.is_finite()));
    }
    #[test]
    fn silence_has_finite_metrics() {
        let a = Audio {
            sample_rate: 48000,
            channels: 2,
            samples: vec![0.0; 960],
        };
        let m = analyze(&a);
        assert_eq!(m.rms, 0.0);
        assert_eq!(m.duration, 0.01);
    }
    #[test]
    fn automation_interpolates() {
        assert_eq!(
            automate(
                &[
                    Point {
                        time: 0.0,
                        value: -12.0
                    },
                    Point {
                        time: 2.0,
                        value: 0.0
                    }
                ],
                1.0,
                0.0
            ),
            -6.0
        );
    }
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Effect {
    Gain {
        db: f32,
    },
    Eq {
        frequency: f32,
        gain: f32,
        q: f32,
    },
    Highpass {
        frequency: f32,
    },
    Lowpass {
        frequency: f32,
    },
    Compressor {
        threshold: f32,
        ratio: f32,
        attack: f32,
        release: f32,
    },
    Limiter {
        ceiling: f32,
    },
    Fade {
        start: f64,
        duration: f64,
        direction: String,
    },
    Denoise {
        strength: f32,
    },
    Spectral {
        start: f64,
        end: f64,
        low_hz: f32,
        high_hz: f32,
        gain_db: f32,
    },
}
fn apply_effects(samples: &mut [f32], rate: u32, effects: &[Effect]) {
    for effect in effects {
        match effect {
            Effect::Gain { db: gain } => {
                for sample in samples.iter_mut() {
                    *sample *= db(*gain);
                }
            }
            Effect::Limiter { ceiling } => {
                let limit = db(*ceiling);
                for sample in samples.iter_mut() {
                    *sample = sample.clamp(-limit, limit);
                }
            }
            Effect::Fade {
                start,
                duration,
                direction,
            } => {
                for (frame, pair) in samples.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                    let t = frame as f64 / f64::from(rate);
                    let ramp = ((t - start) / duration).clamp(0.0, 1.0) as f32;
                    let gain = if direction == "out" { 1.0 - ramp } else { ramp };
                    for sample in pair {
                        *sample *= gain;
                    }
                }
            }
            Effect::Compressor {
                threshold,
                ratio,
                attack,
                release,
            } => {
                let threshold = db(*threshold);
                let attack = (-1.0 / (attack.max(0.1) * 0.001 * rate as f32)).exp();
                let release = (-1.0 / (release.max(1.0) * 0.001 * rate as f32)).exp();
                let mut envelope = 0_f32;
                for pair in samples.as_chunks_mut::<2>().0 {
                    let peak = pair[0].abs().max(pair[1].abs());
                    let coefficient = if peak > envelope { attack } else { release };
                    envelope = coefficient * envelope + (1.0 - coefficient) * peak;
                    let gain = if envelope > threshold {
                        (envelope / threshold).powf(1.0 / ratio.max(1.0) - 1.0)
                    } else {
                        1.0
                    };
                    for sample in pair {
                        *sample *= gain;
                    }
                }
            }
            Effect::Eq { frequency, gain, q } => {
                let omega = std::f32::consts::TAU * frequency.min(rate as f32 * 0.49) / rate as f32;
                let alpha = omega.sin() / (2.0 * q.max(0.1));
                let a = 10_f32.powf(*gain / 40.0);
                biquad(
                    samples,
                    [1.0 + alpha * a, -2.0 * omega.cos(), 1.0 - alpha * a],
                    [1.0 + alpha / a, -2.0 * omega.cos(), 1.0 - alpha / a],
                );
            }
            Effect::Highpass { frequency } | Effect::Lowpass { frequency } => {
                let omega = std::f32::consts::TAU * frequency.min(rate as f32 * 0.49) / rate as f32;
                let alpha = omega.sin() / std::f32::consts::SQRT_2;
                let cos = omega.cos();
                let b = if matches!(effect, Effect::Highpass { .. }) {
                    [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0]
                } else {
                    [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0]
                };
                biquad(samples, b, [1.0 + alpha, -2.0 * cos, 1.0 - alpha]);
            }
            Effect::Spectral { .. } | Effect::Denoise { .. } => {
                spectral_effect(samples, rate, effect)
            }
        }
    }
}
fn biquad(samples: &mut [f32], b: [f32; 3], a: [f32; 3]) {
    for ch in 0..2 {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for pair in samples.as_chunks_mut::<2>().0 {
            let x = pair[ch];
            let y = (b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            pair[ch] = y;
        }
    }
}
fn spectral_effect(samples: &mut [f32], rate: u32, effect: &Effect) {
    let size = 2048;
    let hop = 512;
    let frames = samples.len() / 2;
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(size);
    let inverse = planner.plan_fft_inverse(size);
    let window: Vec<f32> = (0..size)
        .map(|n| 0.5 - 0.5 * (std::f32::consts::TAU * n as f32 / size as f32).cos())
        .collect();
    let mut result = vec![0.0_f32; samples.len()];
    let mut weights = vec![0.0_f32; frames];
    for start in (0..frames).step_by(hop) {
        for n in 0..size.min(frames - start) {
            weights[start + n] += window[n] * window[n];
        }
        for ch in 0..2 {
            let mut buffer: Vec<_> = (0..size)
                .map(|n| {
                    Complex::new(
                        samples.get((start + n) * 2 + ch).copied().unwrap_or(0.0) * window[n],
                        0.0,
                    )
                })
                .collect();
            fft.process(&mut buffer);
            for (bin, value) in buffer.iter_mut().enumerate() {
                let frequency = bin.min(size - bin) as f32 * rate as f32 / size as f32;
                let time = start as f64 / f64::from(rate);
                let gain = match effect {
                    Effect::Spectral {
                        start,
                        end,
                        low_hz,
                        high_hz,
                        gain_db,
                    } if time >= *start
                        && time <= *end
                        && frequency >= *low_hz
                        && frequency <= *high_hz =>
                    {
                        db(*gain_db)
                    }
                    Effect::Denoise { strength } => {
                        let threshold =
                            10_f32.powf((-80.0 + strength.min(97.0) * 0.5) / 20.0) * size as f32;
                        (value.norm() / threshold.max(0.00001)).clamp(0.0, 1.0)
                    }
                    _ => 1.0,
                };
                *value *= gain;
            }
            inverse.process(&mut buffer);
            for n in 0..size.min(frames - start) {
                result[(start + n) * 2 + ch] += buffer[n].re / size as f32 * window[n];
            }
        }
    }
    for (n, pair) in samples.as_chunks_mut::<2>().0.iter_mut().enumerate() {
        if weights[n] > 0.00001 {
            for ch in 0..2 {
                pair[ch] = result[n * 2 + ch] / weights[n];
            }
        }
    }
}
