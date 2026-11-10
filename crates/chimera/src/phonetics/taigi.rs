//! Taiwanese Hokkien (Tâi-lô) lyrics → sung syllables. A song's tones are carried by its melody,
//! so the tone marks are dropped and only the syllable's sounds are kept.
//!
//! Tâi-lô → this engine's symbols (modifiers are `inventory::Mods`):
//!   ph th kh tsh → pʰ tʰ kʰ tsʰ     p t k ts → p˭ t˭ k˭ ts˭ (unaspirated)    j → dz   ng → ŋ
//!   o → ɤ   oo → ɔ   ir → ɨ   er → ə   nn → ⁿ on the vowel
//!   -p -t -k → p t k   -h → ʔ   -m -n -ng → m n ŋ
//!   a medial i/u before a vowel is a glide in the onset (tio̍h = t j ɤ ʔ); a final i/u is a glide
//!   in the coda (thàu = tʰ a w); a lone m or ng is a syllabic nasal (mn̂g = m ŋ̍).
//! Words are separated by spaces, syllables of a word by hyphens; `-` alone holds the vowel over
//! the next note; `,` and `.` end a phrase.

use super::{Segment, Syllable};

/// A letter with its tone mark taken off ("à" → "a"); combining marks are dropped.
fn plain(c: char) -> Option<char> {
    Some(match c {
        '\u{300}' | '\u{301}' | '\u{302}' | '\u{304}' | '\u{30D}' | '\u{30B}' | '\u{306}' | '\u{358}' => return None,
        'à' | 'á' | 'â' | 'ā' => 'a',
        'è' | 'é' | 'ê' | 'ē' => 'e',
        'ì' | 'í' | 'î' | 'ī' => 'i',
        'ò' | 'ó' | 'ô' | 'ō' => 'o',
        'ù' | 'ú' | 'û' | 'ū' => 'u',
        'ǹ' | 'ń' => 'n',
        'ḿ' => 'm',
        c => c.to_ascii_lowercase(),
    })
}

/// Longest first, so "tsh" is tried before "ts" and "ng" before "n".
const ONSETS: [(&str, &str); 18] = [
    ("tsh", "tsʰ"), ("ts", "ts˭"), ("ph", "pʰ"), ("th", "tʰ"), ("kh", "kʰ"), ("ng", "ŋ"),
    ("p", "p˭"), ("t", "t˭"), ("k", "k˭"), ("b", "b"), ("g", "g"), ("m", "m"), ("n", "n"),
    ("l", "l"), ("s", "s"), ("j", "dz"), ("h", "h"), ("", ""),
];

fn units(v: &str) -> Option<Vec<&'static str>> {
    let c: Vec<char> = v.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let two: String = c[i..(i + 2).min(c.len())].iter().collect();
        match two.as_str() {
            "oo" => { out.push("ɔ"); i += 2; continue; }
            "ir" => { out.push("ɨ"); i += 2; continue; }
            "er" => { out.push("ə"); i += 2; continue; }
            _ => {}
        }
        out.push(match c[i] { 'a' => "a", 'e' => "e", 'i' => "i", 'o' => "ɤ", 'u' => "u", _ => return None });
        i += 1;
    }
    Some(out)
}

fn seg(s: &str) -> Segment {
    Segment::new(s)
}

/// One Tâi-lô syllable ("tshut", tone marks allowed) → onset, nucleus, coda.
pub fn syllable(tailo: &str) -> Option<(Vec<Segment>, Segment, Vec<Segment>)> {
    let word: String = tailo.chars().filter_map(plain).collect();
    for (on, ipa) in ONSETS.iter().filter(|(o, _)| word.starts_with(o)) {
        let rest = &word[on.len()..];
        let mut onset: Vec<Segment> = if ipa.is_empty() { vec![] } else { vec![seg(ipa)] };
        // a lone nasal is the syllable
        if rest == "ng" || rest == "m" {
            return Some((onset, seg(if rest == "m" { "m" } else { "ŋ" }), vec![]));
        }
        let (rest, mut coda) = if let Some(r) = rest.strip_suffix("ng") {
            (r, vec![seg("ŋ")])
        } else if rest.ends_with("nn") {
            (rest, vec![])
        } else if let Some(r) = rest.strip_suffix('m') {
            (r, vec![seg("m")])
        } else if let Some(r) = rest.strip_suffix('n') {
            (r, vec![seg("n")])
        } else if let Some(r) = rest.strip_suffix('p') {
            (r, vec![seg("p")])
        } else if let Some(r) = rest.strip_suffix('t') {
            (r, vec![seg("t")])
        } else if let Some(r) = rest.strip_suffix('k') {
            (r, vec![seg("k")])
        } else if let Some(r) = rest.strip_suffix('h') {
            (r, vec![seg("ʔ")])
        } else {
            (rest, vec![])
        };
        let (vowels, nasal) = match rest.strip_suffix("nn") {
            Some(v) => (v, true),
            None => (rest, false),
        };
        let Some(u) = units(vowels) else { continue };
        let (glide_in, main, glide_out): (Option<&str>, &str, Option<&str>) = match u.as_slice() {
            [v] => (None, v, None),
            ["i", "u"] => (None, "i", Some("w")),
            ["u", "i"] if nasal => (Some("w"), "i", None), // khuìnn = [kʰuĩ]
            ["u", "i"] => (None, "u", Some("j")),
            [a, "u"] => (None, a, Some("w")),
            [a, "i"] => (None, a, Some("j")),
            ["i", b] => (Some("j"), b, None),
            ["u", b] => (Some("w"), b, None),
            ["i", b, "u"] => (Some("j"), b, Some("w")),
            ["u", b, "i"] => (Some("w"), b, Some("j")),
            _ => continue,
        };
        if let Some(g) = glide_in {
            onset.push(seg(g));
        }
        if let Some(g) = glide_out {
            coda.insert(0, seg(g));
        }
        // "ong" and "ok" are [ɔŋ] and [ɔk]; a bare "o" is [ɤ]
        let main = if main == "ɤ" && coda.first().is_some_and(|c| c.ipa == "ŋ" || c.ipa == "k") { "ɔ" } else { main };
        let nucleus = seg(&format!("{main}{}", if nasal { "ⁿ" } else { "" }));
        return Some((onset, nucleus, coda));
    }
    None
}

/// Tâi-lô lyrics → one syllable per sung note. An unreadable syllable is an error naming it.
pub fn lyrics_to_syllables(text: &str) -> Result<Vec<Syllable>, String> {
    let mut out: Vec<Syllable> = Vec::new();
    for tok in text.split_whitespace() {
        if matches!(tok, "," | "." | "，" | "。") {
            if let Some(l) = out.last_mut() {
                l.phrase_end = true;
            }
            continue;
        }
        if tok == "-" || tok == "~" {
            if let Some(prev) = out.last() {
                out.push(Syllable { text: "~".into(), onset: vec![], nucleus: prev.nucleus.clone(), coda: vec![], melisma: Some(true), word_end: prev.word_end, phrase_end: false });
            }
            continue;
        }
        for part in tok.split('-').filter(|p| !p.is_empty()) {
            let (onset, nucleus, coda) = syllable(part).ok_or_else(|| format!("can't read the syllable \"{part}\""))?;
            out.push(Syllable { text: part.to_string(), onset, nucleus, coda, melisma: None, word_end: false, phrase_end: false });
        }
        if let Some(l) = out.last_mut() {
            l.word_end = true;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ipa(s: &str) -> String {
        let (o, n, c) = syllable(s).unwrap_or_else(|| panic!("{s}"));
        let j = |v: &[Segment]| v.iter().map(|x| x.ipa.clone()).collect::<Vec<_>>().join(".");
        format!("{}|{}|{}", j(&o), n.ipa, j(&c))
    }

    #[test]
    fn glides_codas_and_syllabic_nasals() {
        assert_eq!(ipa("thàu"), "tʰ|a|w");
        assert_eq!(ipa("tsá"), "ts˭|a|");
        assert_eq!(ipa("tio̍h"), "t˭.j|ɤ|ʔ");
        assert_eq!(ipa("tshut"), "tsʰ|u|t");
        assert_eq!(ipa("mn̂g"), "m|ŋ|");
        assert_eq!(ipa("tiong"), "t˭.j|ɔ|ŋ");
        assert_eq!(ipa("tiō"), "t˭.j|ɤ|");
    }

    #[test]
    fn nasal_vowels_and_glides() {
        assert_eq!(ipa("kuānn"), "k˭.w|aⁿ|");
        assert_eq!(ipa("thinn"), "tʰ|iⁿ|");
        assert_eq!(ipa("kng"), "k˭|ŋ|");
        assert_eq!(ipa("tiū"), "t˭|i|w");
        assert_eq!(ipa("ji̍t"), "dz|i|t");
        assert_eq!(ipa("hó"), "h|ɤ|");
        assert_eq!(ipa("sann"), "s|aⁿ|");
        assert_eq!(ipa("khuìnn"), "kʰ.w|iⁿ|");
        assert_eq!(ipa("muí"), "m|u|j");
    }

    #[test]
    fn every_syllable_class_reads() {
        // the syllables of the test song as an inventory (sorted, each once), not its lyrics: covers every onset, rhyme and coda class
        let syllables = "bô bāng gún hi hó iâm ji̍t jua̍h jím kah khang khuài khuè khuìnn khóo kiann kiânn kng kui kuânn kuānn kàu kòo lo̍h lâng lâu líng mn̂g mn̄g muí m̄ ng ná nî nā sann sik sin sing siū sng so suah suann sî sûn ta tang ta̍h thinn thàu thâu tiong tio̍h tiō tiū tshi tshia tshiah tshut tshuì tshám tsháu tshân tsiah tsiām tsuí tsá tuā tàu tǹg ua̍h uī á ê āu ū";
        for w in syllables.split(' ') {
            assert!(syllable(w).is_some(), "{w}");
        }
    }
}
