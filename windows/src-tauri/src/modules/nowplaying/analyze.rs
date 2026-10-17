// Spectrum of what the PC plays: pure functions (samples in, 16 band levels out) plus the FFT state.
// Nothing here touches the OS or keeps audio: a window of samples goes in, numbers come out.

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

pub const FFT_N: usize = 1024;
pub const BANDS: usize = 16;
const LO_HZ: f32 = 50.0;
const HI_HZ: f32 = 12_000.0;
/// Band levels map -60 dBFS..-12 dBFS to 0..1 (music sits well below full scale).
const FLOOR_DB: f32 = -60.0;
const SPAN_DB: f32 = 48.0;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SampleFmt {
    F32,
    I16,
}

/// First FFT bin of each band plus the end (`bands + 1` values, non-decreasing, all <= n/2 + 1; a band may be empty at low rates).
pub fn band_edges(sample_rate: u32, n: usize, bands: usize) -> Vec<usize> {
    let max = n / 2 + 1;
    let ratio = (HI_HZ / LO_HZ).powf(1.0 / bands as f32);
    let mut edges = vec![1usize];
    for k in 1..=bands {
        let hz = LO_HZ * ratio.powi(k as i32);
        let bin = (hz * n as f32 / sample_rate.max(1) as f32).round() as usize;
        let prev = edges[k - 1];
        edges.push(bin.max(prev + 1).min(max)); // low rates run out of bins: trailing bands are empty
    }
    edges
}

/// Magnitude (already scaled so a full-scale sine reads about 1.0) to 0..1.
pub fn level_of_mag(mag: f32) -> f32 {
    if mag <= 1e-9 {
        return 0.0;
    }
    ((20.0 * mag.log10() - FLOOR_DB) / SPAN_DB).clamp(0.0, 1.0)
}

/// One loudness number from the bands (plain mean).
pub fn loudness(bands: &[f32]) -> f32 {
    if bands.is_empty() {
        0.0
    } else {
        bands.iter().sum::<f32>() / bands.len() as f32
    }
}

/// Interleaved little-endian samples to mono f32 in -1..1.
pub fn mono_from_bytes(data: &[u8], channels: usize, fmt: SampleFmt) -> Vec<f32> {
    let ch = channels.max(1);
    let size = match fmt {
        SampleFmt::F32 => 4,
        SampleFmt::I16 => 2,
    };
    data.chunks_exact(size * ch)
        .map(|frame| {
            let sum: f32 = frame
                .chunks_exact(size)
                .map(|b| match fmt {
                    SampleFmt::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                    SampleFmt::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                })
                .sum();
            sum / ch as f32
        })
        .collect()
}

pub struct Analyzer {
    plan: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spec: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    edges: Vec<usize>,
}

impl Analyzer {
    pub fn new(sample_rate: u32) -> Self {
        let plan = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_N);
        let window = (0..FFT_N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_N as f32 - 1.0)).cos()).collect();
        Analyzer {
            input: plan.make_input_vec(),
            spec: plan.make_output_vec(),
            scratch: plan.make_scratch_vec(),
            edges: band_edges(sample_rate, FFT_N, BANDS),
            plan,
            window,
        }
    }

    /// `samples` is the latest FFT_N mono samples (shorter input is zero padded).
    pub fn analyze(&mut self, samples: &[f32]) -> [f32; BANDS] {
        for (i, v) in self.input.iter_mut().enumerate() {
            *v = samples.get(i).copied().unwrap_or(0.0) * self.window[i];
        }
        let mut out = [0.0; BANDS];
        if self.plan.process_with_scratch(&mut self.input, &mut self.spec, &mut self.scratch).is_err() {
            return out;
        }
        // A Hann-windowed full-scale sine peaks at N/4.
        let scale = 4.0 / FFT_N as f32;
        for (b, o) in out.iter_mut().enumerate() {
            let (lo, hi) = (self.edges[b].min(self.spec.len()), self.edges[b + 1].min(self.spec.len()));
            if lo >= hi {
                continue;
            }
            let peak = self.spec[lo..hi].iter().map(|c| c.norm()).fold(0.0, f32::max);
            *o = level_of_mag(peak * scale);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, rate: u32, amp: f32) -> Vec<f32> {
        (0..FFT_N).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect()
    }

    #[test]
    fn edges_strictly_increase_and_stay_in_range() {
        for rate in [8_000u32, 11_025, 22_050, 44_100, 48_000, 96_000] {
            let e = band_edges(rate, FFT_N, BANDS);
            assert_eq!(e.len(), BANDS + 1);
            assert!(e.windows(2).all(|w| w[0] <= w[1]), "{rate}: {e:?}");
            if rate >= 44_100 {
                assert!(e.windows(2).all(|w| w[0] < w[1]), "{rate}: {e:?}");
            }
            assert!(*e.last().unwrap() <= FFT_N / 2 + 1);
        }
    }

    #[test]
    fn low_sample_rates_do_not_panic() {
        for rate in [8_000u32, 11_025] {
            let mut a = Analyzer::new(rate);
            let b = a.analyze(&sine(500.0, rate, 0.5));
            assert!(b.iter().any(|v| *v > 0.5), "{rate}: {b:?}");
        }
    }

    #[test]
    fn silence_is_zero() {
        let mut a = Analyzer::new(48_000);
        assert_eq!(a.analyze(&vec![0.0; FFT_N]), [0.0; BANDS]);
        assert_eq!(loudness(&[]), 0.0);
    }

    #[test]
    fn a_tone_lights_its_own_band_most() {
        let mut a = Analyzer::new(48_000);
        let e = band_edges(48_000, FFT_N, BANDS);
        let bands = a.analyze(&sine(1_000.0, 48_000, 0.5));
        let bin = (1_000.0 * FFT_N as f32 / 48_000.0).round() as usize;
        let own = (0..BANDS).find(|&b| e[b] <= bin && bin < e[b + 1]).unwrap();
        let top = bands.iter().enumerate().max_by(|x, y| x.1.total_cmp(y.1)).unwrap().0;
        assert_eq!(top, own);
        assert!(bands[own] > 0.8, "{:?}", bands);
        assert!(bands[BANDS - 1] < 0.2);
    }

    #[test]
    fn quiet_maps_below_loud() {
        assert_eq!(level_of_mag(0.0), 0.0);
        assert!(level_of_mag(0.001) < level_of_mag(0.1));
        assert_eq!(level_of_mag(1.0), 1.0);
    }

    #[test]
    fn mono_mixes_channels_and_formats() {
        let mut f = Vec::new();
        for v in [1.0f32, 0.0, 0.5, 0.5] {
            f.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(mono_from_bytes(&f, 2, SampleFmt::F32), vec![0.5, 0.5]);
        let mut i = Vec::new();
        for v in [16384i16, 16384, -32768, 0] {
            i.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(mono_from_bytes(&i, 2, SampleFmt::I16), vec![0.5, -0.5]);
        // A partial trailing frame is ignored.
        assert_eq!(mono_from_bytes(&f[..6], 2, SampleFmt::F32).len(), 0);
    }
}
