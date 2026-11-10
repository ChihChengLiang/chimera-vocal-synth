//! The water buffalo: a moo at the pitch asked for, loud enough, and a nose that opens at the
//! ends (the "m") and closes in the middle (the "oo").

use chimera::analysis::pitch::{YinOpts, yin_pitch};
use chimera::creatures::{CreatureVoice, creature_by_id};

const FS: f64 = 48000.0;

fn render(v: &mut CreatureVoice, sec: f64) -> Vec<f32> {
    let mut out = vec![0f32; (sec * FS) as usize];
    for block in out.chunks_mut(128) {
        v.render(block);
    }
    out
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

#[test]
fn a_held_note_is_at_the_pitch_asked_for() {
    let def = creature_by_id("buffalo").expect("buffalo is registered");
    let pitch = def.param_index("pitch").unwrap();
    for hz in [55.0, 85.0, 130.0] {
        let mut v = CreatureVoice::new(def, FS, &[(pitch, hz)]);
        v.set_gate(1.0);
        let out = render(&mut v, 1.6);
        let frame: Vec<f64> = out[(0.9 * FS) as usize..(0.9 * FS) as usize + 4096].iter().map(|x| *x as f64).collect();
        let est = yin_pitch(&frame, FS, YinOpts { min_f0: Some(25.0), max_f0: Some(400.0), ..Default::default() });
        assert!((est.f0 / hz - 1.0).abs() < 0.03, "asked {hz} Hz, measured {} Hz", est.f0);
        assert!(rms(&out[(0.9 * FS) as usize..]) > 0.01, "a held note at {hz} Hz is nearly silent");
    }
}

#[test]
fn every_call_sounds_and_ends_in_silence() {
    let def = creature_by_id("buffalo").unwrap();
    for call in &def.calls {
        let mut v = CreatureVoice::new(def, FS, &[]);
        v.play_call_id(call.id, None, 1.0);
        let out = render(&mut v, 4.0);
        assert!(out.iter().all(|x| x.is_finite()), "{}: non-finite output", call.id);
        assert!(rms(&out[..(1.0 * FS) as usize]) > 0.01, "{}: silent", call.id);
        assert!(rms(&out[out.len() - 4800..]) < 0.002, "{}: still sounding after its end", call.id);
    }
}
