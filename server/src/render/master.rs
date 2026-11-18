//! Shared master chain: sends -> delay + reverb -> limiter -> destination.

use super::{gain, RenderConfig, SAMPLE_RATE};
use crate::prng::Mulberry32;
use web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use web_audio_api::node::{
    AudioNode, BiquadFilterType, GainNode,
};
use web_audio_api::AudioBuffer;

pub const REVERB_SECS: f64 = 1.8;
pub const DELAY_BEATS: f64 = 0.75;
pub const DELAY_FEEDBACK: f32 = 0.4;
pub const DELAY_LP_HZ: f32 = 3000.0;
pub const DELAY_RETURN: f32 = 0.7;
pub const REVERB_RETURN: f32 = 0.8;
/// Trim after the limiter (which has automatic makeup gain). A lone instrument at velocity 100 peaks around -13 dBFS;
/// eight seats stacked on the same beats at full velocity still stay just under 0 dBFS (0.8 clipped there).
pub const OUTPUT_TRIM: f32 = 0.7;

pub struct Master {
    /// Dry input (everything ends up here).
    pub dry: GainNode,
    pub delay_in: GainNode,
    pub reverb_in: GainNode,
    // Held so the nodes live as long as the context renders.
    _keep: Vec<Box<dyn std::any::Any>>,
}

impl Master {
    pub fn new(ctx: &OfflineAudioContext, cfg: &RenderConfig) -> Self {
        let dry = gain(ctx, 1.0);
        let delay_in = gain(ctx, 1.0);
        let reverb_in = gain(ctx, 1.0);

        // Limiter.
        let limiter = ctx.create_dynamics_compressor();
        limiter.threshold().set_value(-6.0);
        limiter.knee().set_value(0.0);
        limiter.ratio().set_value(20.0);
        limiter.attack().set_value(0.003);
        limiter.release().set_value(0.1);
        let trim = gain(ctx, OUTPUT_TRIM);
        limiter.connect(&trim);
        trim.connect(&ctx.destination());
        dry.connect(&limiter);

        // Delay: in -> delay -> lowpass -> (feedback -> delay) and -> return -> limiter.
        let beat = 60.0 / cfg.bpm as f64;
        let delay = ctx.create_delay(4.0);
        delay.delay_time().set_value((DELAY_BEATS * beat) as f32);
        let mut lp = ctx.create_biquad_filter();
        lp.set_type(BiquadFilterType::Lowpass);
        lp.frequency().set_value(DELAY_LP_HZ);
        lp.q().set_value(0.7071);
        let fb = gain(ctx, DELAY_FEEDBACK);
        let delay_ret = gain(ctx, DELAY_RETURN);
        delay_in.connect(&delay);
        delay.connect(&lp);
        lp.connect(&fb);
        fb.connect(&delay);
        lp.connect(&delay_ret);
        delay_ret.connect(&limiter);

        // Reverb: seeded noise IR.
        let ir_len = (REVERB_SECS * SAMPLE_RATE as f64) as usize;
        let mut chans = Vec::new();
        for c in 0..2 {
            let mut rng = Mulberry32::from_key(&format!("{}:reverb:{}", cfg.seed, c));
            let mut d = vec![0f32; ir_len];
            for (i, s) in d.iter_mut().enumerate() {
                let t = i as f64 / SAMPLE_RATE as f64;
                let env = (-6.9 * t / REVERB_SECS).exp();
                *s = (rng.next_bipolar() * env) as f32;
            }
            chans.push(d);
        }
        let ir = AudioBuffer::from(chans, SAMPLE_RATE);
        let conv = ctx.create_convolver();
        let mut conv = conv;
        conv.set_buffer(ir);
        let rev_ret = gain(ctx, REVERB_RETURN);
        reverb_in.connect(&conv);
        conv.connect(&rev_ret);
        rev_ret.connect(&limiter);

        let keep: Vec<Box<dyn std::any::Any>> = vec![
            Box::new(limiter),
            Box::new(trim),
            Box::new(delay),
            Box::new(lp),
            Box::new(fb),
            Box::new(delay_ret),
            Box::new(conv),
            Box::new(rev_ret),
        ];
        Master { dry, delay_in, reverb_in, _keep: keep }
    }
}
