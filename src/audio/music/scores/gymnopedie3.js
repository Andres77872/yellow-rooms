// Erik Satie, Gymnopédie No. 3 (1888). The composition is in the public
// domain; the note text below is the Mutopia Project edition
// (https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=39, typeset by
// Evin Robertson from the Dover edition), placed in the Public Domain by the
// typesetter. Engraving commands are left in place; audio/music/lily.js skips
// everything that carries no pitch or time.
export default {
  id: 'gymnopedie3',
  title: 'Gymnopédie No. 3',
  composer: 'Erik Satie',
  year: 1888,
  license: 'Public Domain (composition and Mutopia Project edition)',
  source: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=39',
  tempo: 60, // quarter notes per minute: "Lent et grave"
  meter: [3, 4],
  voices: [
    {
      name: 'Melody',
      role: 'melody',
      ly: String.raw`\relative c''' {
  \dynamicUp
  \stemUp
  \slurUp
  R2.^\markup{\hspace #10 "Lent et grave"} |
  R2. |
  R2. |
  R2. |
  a2.( \p \< |
  g4 f e |
  d\! e \> f |
  e d  c\! |
  e2.) |
  g2( \<  g4\! |
  <<\context Voice = "othervoice" {\stemDown r4 <a, f>2 | s2.}
    { d2. \> ~ |  d2.\! } >> |
  <<  d2.) \context Voice = "othervoice" {\stemDown r4 <a f>2}>> |

  r4 c( f \< |
  g2 a4 |
  d,\! e f |
  b, \> a g |
  a2. |
  d,2.\! ~ |
  d2.) |
  e'2.( |
  f4 \< g  f\! |
  e \> d e ~ |
  e2. ~ |
  e4 d c |
  b c  b\! |
  a2.) |

  R2. |
  R2. |
  R2. |
  a'2.( |
  g4 f \< e |
  d e f |
  e  d\! c |
  e2. |
  g2 g4 |
  c, \> b a |
  b2 c4 |
  d2.\! |
  e2.) |

  R2. |
  R2. |
  g2( \< a4 |
  d, e f |
  b, a  g\! |
  a2. \> |
  d,2. ~ |
  d2.\!) |
  e'2.( |
  f4 \< g f |
  e d  e\! ~ |
  e2. ~ |
  e4 \> d c |
  b c b |
  a2.\!) |

  R2. |
  R2. |
  R2. |
  <c a e c>2. ~ |
  <c a e c>2. |
}`,
    },
    {
      name: 'Accompaniment',
      role: 'chords',
      ly: String.raw`\relative c'' {
  \override NoteColumn   #'horizontal-shift = #1
  \stemDown
  r4 <a  e c>2\p |
 r4 <g e b>2 |
  r4 <a e c>2 |
 r4 <g e b>2 |
  r4 <a e c>2 |
 r4 <a e c>2 |
  r4 <g d bes>2 |
 r4 <f d a>2 |
  \change Staff=bass
  \stemUp
  r4 <e c a>2 |
 r4 <e b g>2 |
  r4 <b g d>2 |
 r4 <f' c a>2 |
  r4 <b, g d>2 |

  r4 <f' c a>2 |
 r4 <g e b>2 |
  r4 <f c a>2 |
 r4 <e c a>2 |
  r4 <f c a>2 |
 r4 <f c a>2 |
  r4 <g e b>2 |

  \change Staff=treble
  \stemDown
  r4 <a  e c>2\pp |
  r4 <g e b>2 |
 r4 <a e c>2 |
  r4 <g e b>2 |
 r4 <a e c>2 |
  r4 <g e b>2 |
 r4 <f c a>2 |

  r4 <g  e b>2\pp |
 r4 <a e c>2 |
  r4 <g e b>2 |
 r4 <a  e c>2\p |
  r4 <a e c>2 |
 r4 <g d bes>2 |
  \change Staff=bass
  \stemUp
  r4 <f d a>2 |
  r4 <e c a>2 |
  r4 <e b g>2 |
  r4 <f c a>2 |
  r4 <e b g>2 |
  r4 <f c a>2 |
  \change Staff=treble
  \stemDown
  r4 <a e c>2 |

  \change Staff=bass
  \stemUp
  r4 <e c a>2 |
  r4 <f c a>2 |
  r4 <g e b>2 |
  r4 <f c a>2 |
  r4 <e c a>2 |
  r4 <f c a>2 |
  r4 <f c a>2 |
  r4 <g e b>2 |
  \change Staff=treble
  \stemDown
  r4 <a  e c>2\pp |
  r4 <g e b>2 |
  r4 <a e c>2 |
  r4 <g e b>2 |
  r4 <a e c>2 |
  r4 <g e b>2 |
  r4 <f c a>2 |

  r4 <g  e b>2\pp |
  r4 <a e c>2 |
  r4 <g e b>2 |
  s2. |
}`,
    },
    {
      name: 'Bass',
      role: 'bass',
      ly: String.raw`\relative c {
  \stemDown
  a2. |
  d,2. |
  a'2. |
  d,2. |
  a'2. |
  c2. |
  g2. |
  d2. |
  a'2. |
  e2. |
  g2. |
  d2. |
  g2. |

  d2. |
  g,2. |
  g2. |
  g2. |
  d'2. |
  g,2. |
  g2. |
  c2. |
  e2. |
  c2. |
  e2. |
  c2. |
  e2. |
  a2. |

  d,2. |
  a'2. |
  d,2. |
  a'2. |
  c2. |
  g2. |
  d2. |
  a'2. |
  e2. |
  e2. |
  e2. |
  d2. |
  d2. |

  d2. |
  d2. |
  g,2. |
  g2. |
  g2. |
  d'2. |
  g,2. |
  g2. |
  c2. |
  e2. |
  c2. |
  e2. |
  c2. |
  e2. |
  a2. |

  d,2. |
  a'2. |
  d,2. |
  <a' e a,>2. ~ |
  <a e a,>2. |
}`,
    },
  ],
}
