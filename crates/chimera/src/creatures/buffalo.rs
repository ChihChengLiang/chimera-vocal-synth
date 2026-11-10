//! Water buffalo: a heavy bovid's low moo and bellow. Large vocal folds make a pitch of 50–150 Hz;
//! a long throat and mouth shape it, and the moo's "m" is made with the nose: the velum is open
//! while the mouth is shut, then closes as the mouth opens to an "oo" and drops again at the end.

use super::build::{CMH2O, fill_areas};
use super::mammal::{MammalAirway, MammalSpec, mammal_airway, mammal_noise, step_glottis};
use super::types::{CallDef, CallKey, CreatureDef, CreatureGroup, CreatureSim, Curve, GateTimes, ParamDef};
use crate::airway::network::{AirwayNetwork, Tube};
use crate::math::js_min;

const PITCH: usize = 0;
const PRESSURE: usize = 1;
const MOUTH: usize = 2;
const NASAL: usize = 3;
const ROUGH: usize = 4;

pub struct Buffalo {
    a: MammalAirway,
    tubes: Vec<(&'static str, Tube)>,
    velum: usize,
}

fn create(fs: f64) -> Box<dyn CreatureSim> {
    let a = mammal_airway(fs, MammalSpec { trachea: (55.0, 16.0), pharynx: (14.0, 13.0), oral: (24.0, 11.0), nasal: Some((26.0, 5.0)), wall: None, wall_radiation: Some(0.6), coarse: Some(1.2), nasal_radiates: None }, |_, _| {});
    let velum = a.velum.expect("buffalo has a nasal passage");
    let tubes = vec![("trachea", a.trachea), ("pharynx", a.pharynx), ("oral", a.oral), ("nasal", a.nasal.expect("nasal tube"))];
    let mut b = Buffalo { a, tubes, velum };
    b.a.glottis_src.threshold = 1.5 * CMH2O;
    Box::new(b)
}

impl CreatureSim for Buffalo {
    fn net(&self) -> Option<&AirwayNetwork> {
        Some(&self.a.net)
    }
    fn net_mut(&mut self) -> Option<&mut AirwayNetwork> {
        Some(&mut self.a.net)
    }
    fn tubes(&self) -> &[(&'static str, Tube)] {
        &self.tubes
    }
    fn gain(&self) -> f64 {
        GAIN
    }
    fn control(&mut self, p: &[f64], gate: f64, _dt: f64) {
        let a = &mut self.a;
        a.net.set_fixed_pressure(a.lungs, p[PRESSURE] * CMH2O * gate);
        let g = &mut a.glottis_src.params;
        g.f0 = p[PITCH];
        g.amplitude = 1.4;
        g.open_quotient = 0.72;
        g.closure_sharpness = 0.25;
        g.effort = 0.5;
        g.chaos = p[ROUGH] * 0.6;
        g.jitter = 0.004;
        g.shimmer = 0.02;
        // the nose: open for the "m" and the last breath of the moo, shut while the mouth is open
        a.net.set_port_target(self.velum, 0.05 + 3.0 * p[NASAL]);
        let ph_areas = fill_areas(a.pharynx, |_| 13.0, &mut a.phar_area);
        a.net.set_tube_targets(a.pharynx, ph_areas, None, None);
        let mouth = p[MOUTH];
        let or_areas = fill_areas(a.oral, |u| if u > 0.8 { 0.25 + 14.0 * mouth } else { 11.0 }, &mut a.oral_area);
        a.net.set_tube_targets(a.oral, or_areas, None, None);
        mammal_noise(a, 3e-7, None);
    }
    #[inline]
    fn sample(&mut self) -> f64 {
        step_glottis(&mut self.a);
        self.a.net.step()
    }
    fn source_state(&self, out: &mut Vec<(&'static str, f64)>) {
        out.clear();
        out.push(("glottis", js_min(1.0, self.a.glottis_src.area / 1.4)));
    }
}

/// fixed output normalisation (found by rendering a moo to a peak near 0.3)
const GAIN: f64 = 6.0e-8;

pub fn def() -> CreatureDef {
    let k = CallKey::new;
    CreatureDef {
        id: "buffalo",
        name: "Water buffalo",
        latin: "Bubalus bubalis",
        group: CreatureGroup::Mammal,
        blurb: "A low moo from big vocal folds: the nose makes the \"m\", the mouth opens to an \"oo\", and the throat adds a bellow's rasp.",
        role: "Bass moos, a bellowing sub-bass",
        oversample: 1,
        gate_times: Some(GateTimes { attack: 0.04, release: 0.12 }),
        params: vec![
            ParamDef::new("pitch", "Pitch", 30.0, 300.0, 85.0).unit("Hz").log().smooth(0.04).pitch(),
            ParamDef::new("pressure", "Breath pressure", 3.0, 40.0, 14.0).unit("cmH₂O").smooth(0.03),
            ParamDef::new("mouth", "Mouth opening", 0.0, 1.0, 0.5).smooth(0.06),
            ParamDef::new("nasal", "Nose open", 0.0, 1.0, 0.3).smooth(0.05),
            ParamDef::new("rough", "Roughness", 0.0, 1.0, 0.15).smooth(0.05),
        ],
        calls: vec![
            CallDef::new(
                "moo",
                "Moo",
                "A long moo: nose, then open mouth, then back to the nose",
                Some(85.0),
                vec![
                    k(0.0, &[("gate", 0.0), ("pitch", 78.0), ("mouth", 0.05), ("nasal", 0.9), ("pressure", 14.0), ("rough", 0.1)]),
                    k(0.08, &[("gate", 1.0)]),
                    k(0.35, &[("pitch", 90.0), ("mouth", 0.8), ("nasal", 0.1)]).curve(Curve::Exp),
                    k(1.3, &[("pitch", 96.0), ("mouth", 0.85)]).curve(Curve::Exp),
                    k(1.9, &[("pitch", 76.0), ("mouth", 0.3), ("nasal", 0.7), ("rough", 0.25)]).curve(Curve::Exp),
                    k(2.2, &[("gate", 1.0)]),
                    k(2.4, &[("gate", 0.0), ("rough", 0.15), ("nasal", 0.3), ("mouth", 0.5)]),
                ],
            ),
            CallDef::new(
                "bellow",
                "Bellow",
                "A loud, rough, falling bellow",
                Some(85.0),
                vec![
                    k(0.0, &[("gate", 0.0), ("pitch", 100.0), ("mouth", 0.9), ("nasal", 0.0), ("pressure", 28.0), ("rough", 0.5)]),
                    k(0.05, &[("gate", 1.0)]),
                    k(1.2, &[("pitch", 60.0), ("rough", 0.8)]).curve(Curve::Exp),
                    k(1.4, &[("gate", 0.0), ("pressure", 14.0), ("rough", 0.15), ("mouth", 0.5), ("nasal", 0.3)]),
                ],
            ),
            CallDef::new(
                "grunt",
                "Grunt",
                "A short, low grunt",
                Some(85.0),
                vec![
                    k(0.0, &[("gate", 0.0), ("pitch", 66.0), ("mouth", 0.4), ("nasal", 0.4), ("pressure", 12.0), ("rough", 0.4)]),
                    k(0.03, &[("gate", 1.0)]),
                    k(0.25, &[("pitch", 58.0)]).curve(Curve::Exp),
                    k(0.32, &[("gate", 0.0), ("rough", 0.15), ("nasal", 0.3), ("mouth", 0.5)]),
                ],
            ),
        ],
        events: vec![],
        create,
    }
    .resolved()
}
