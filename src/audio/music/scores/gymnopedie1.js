// Erik Satie, Gymnopédie No. 1 (1888). The composition is in the public
// domain; the note text below is the Mutopia Project edition
// (https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=37, typeset by
// Evin Robertson from the Dover edition), released into the Public Domain
// ("No rights reserved"). Dynamics and engraving tweaks are left in place;
// audio/music/lily.js skips everything that carries no pitch or time.
export default {
  id: 'gymnopedie1',
  title: 'Gymnopédie No. 1',
  composer: 'Erik Satie',
  year: 1888,
  license: 'Public Domain (composition and Mutopia Project edition)',
  source: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=37',
  tempo: 66, // quarter notes per minute: "Lent et douloureux"
  meter: [3, 4],
  voices: [
    {
      name: 'Melody',
      role: 'melody',
      ly: String.raw`\relative c'' {
  \repeat volta 2 {
    R2. | R2. | R2. | R2. |
    s4 fis( \pp \< a |
    g fis cis |
    b cis\! d\> |
    a2. |
    fis2.\!) ~ |
    fis2. ~ |
    fis2. ~ |
    fis2. |
    s4 fis'\<( a | g fis cis |
    b cis  d\! |
    a2.\> |
    cis2. |
    fis2. |
    e,2.\!) ~ |
    e2. ~ |
    e2. |
    a4(\< b c |
    e d b |
    d c  b\! |
    d2.\> ~ |
    d2\!) d4(\< |
    e f g |
    a c,  d\! |
    e\> d b |
    d2.\! ~ |
    d2) d4  |
  } \alternative {
    {
      g2.( \< |
      fis2.\! |
      b,4 a b |
      cis d e |
      cis d \> e |
      fis,2. |
      < c' a e c>2.\!) |
      <d a fis d>2. |
    } {
      g2.( \< |
      f2.\! |
      b,4 c f |
      e d c |
      e d c \> |
      f,2. |
      <c' a e c>2. |
      < d a f d>2.\!)
    }
  }
}`,
    },
    {
      name: 'Accompaniment',
      role: 'chords',
      ly: String.raw`\relative c' {
  \repeat volta 2 {
    r4 <fis d b>2 |
    r4 <fis cis a>2 |
    r4 <fis d b>2 |
    r4 <fis cis a>2 |
    r4 <fis d b>2 |
    r4 <fis cis a>2 |
    r4 <fis d b>2 |
    r4 <fis cis a>2 |
    r4 <fis  d b>2\f |
    r4 <fis cis a>2 |
    r4 <fis d b>2 |
    r4 <fis cis a>2 |
    r4 <fis  d b>2\pp |
    r4 <fis cis a>2 |
    r4 <fis d b>2 |
    r4 <fis cis a>2 |
    r4 <fis cis a>2 |
    r4 <fis d b>2 |
    r4 <b, g>2 |
    r4 <g' d b>2 |
    r4 <d a f>2
    r4 <e c a>2\p |
    r4 <e b g>2 |
    r4 <e b g d>2 |
    r4 <d a e c>2 |
    r4 <d a fis c>2 |
    r4 <f c a>2 |
    r4 <e c a>2 |
    r4 <e b g d>2 |
    r4 <d a e c>2 |
    r4 <d a fis c>2 |
  }
  \alternative {
    {
      e4\rest <g e b>2 |
      e4\rest <fis cis a>2 |
      d4\rest <fis d b>2 |
      d4\rest <a' e cis>2 |
      d,4\rest <a' fis cis a>2 |
      a,4\rest <d a>4 <g d b> |
      s2. |
      s2. |
    } {
      e4\rest <g e b>2 |
      e4\rest <a f d a>2 |
      d,4\rest <f c a>2 |
      d4\rest <a' e c>2 |
      d,4\rest <a' f c a>2 |
      a,4\rest <d a>4 <g d b> |
      s2. |
      s2. |
    }
  }
}`,
    },
    {
      name: 'Bass',
      role: 'bass',
      ly: String.raw`\relative c {
  \repeat volta 2 {
    g2. | d2. | g2. | d2. | g2. | d2. | g2. | d2. | g2. | d2. | g2. | d2. |
    g2. | d2. | g2. | d2. | fis2. | b,2. | e2. | e2. | d2. |
    a2. | d2. | d2. | d2. | d2. | d2. | d2. | d2. | d2. | d2. |
  }
  \alternative {
    {
      e2. | fis2. | b,2. | e2. | e2. |
      << {c'4\rest b e} e,2. >> |
      <g' a,>2. |
      <d a d,>2. |
    } {
      e,2. | e2. | e2. | e2. | e2. |
      << {c'4\rest b e} e,2. >> |
      <g' a,>2. |
      <d a d,>2. |
    }
  }
}`,
    },
  ],
}
