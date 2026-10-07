// Small illustrations for the demo cards (inline SVG, theme-aware through CSS variables).
import type { DemoId } from "../shared/types.ts";

const A = "var(--accent)";
const T = "var(--text-3)";
const S = "var(--surface-2)";
const B = "var(--bg-elev)";
const R = "var(--bad)";
const G = "var(--ok)";
const H = "var(--mode-heal)";
const W = "var(--warn)";

export const ART: Record<DemoId, string> = {
  search: `<svg viewBox="0 0 320 112" preserveAspectRatio="xMidYMid slice">
    <rect x="22" y="16" width="190" height="26" rx="13" fill="${B}" stroke="${S}"/>
    <circle cx="38" cy="29" r="5" fill="none" stroke="${T}" stroke-width="2"/>
    <text x="52" y="33.5" font-size="12" font-family="var(--font-mono)" fill="${T}">san|</text>
    <rect x="22" y="52" width="190" height="14" rx="5" fill="${S}"/><rect x="22" y="72" width="150" height="14" rx="5" fill="${S}"/><rect x="22" y="92" width="170" height="14" rx="5" fill="${S}" opacity=".7"/>
    <g font-size="10" font-family="var(--font-mono)">
      <rect x="230" y="18" width="70" height="20" rx="6" fill="${A}" opacity=".16"/><text x="238" y="31.5" fill="${A}">?q=san ✓</text>
      <rect x="230" y="52" width="70" height="20" rx="6" fill="${R}" opacity=".14"/><text x="240" y="65.5" fill="${R}">?q=sa ✗</text>
    </g>
    <path d="M265 40v8" stroke="${T}" stroke-width="1.5" stroke-dasharray="2 3"/>
    <path d="M216 62h10" stroke="${R}" stroke-width="2"/>
  </svg>`,
  editor: `<svg viewBox="0 0 320 112" preserveAspectRatio="xMidYMid slice">
    <rect x="20" y="12" width="170" height="92" rx="10" fill="${B}" stroke="${S}"/>
    <rect x="34" y="26" width="90" height="9" rx="3" fill="${T}" opacity=".5"/>
    <rect x="34" y="44" width="140" height="6" rx="3" fill="${S}"/><rect x="34" y="57" width="128" height="6" rx="3" fill="${S}"/><rect x="34" y="70" width="70" height="6" rx="3" fill="${S}"/>
    <rect x="104" y="68" width="40" height="10" rx="2" fill="${R}" opacity=".18"/><path d="M104 73h40" stroke="${R}" stroke-width="1.5"/>
    <g font-size="10" font-family="var(--font-mono)">
      <rect x="206" y="20" width="96" height="22" rx="11" fill="${A}" opacity=".14"/><text x="219" y="34.5" fill="${A}">PUT v7 →</text>
      <rect x="206" y="50" width="96" height="22" rx="11" fill="${W}" opacity=".16"/><text x="216" y="64.5" fill="${W}">← echo v6</text>
      <rect x="206" y="80" width="96" height="22" rx="11" fill="${G}" opacity=".14"/><text x="226" y="94.5" fill="${G}">Saved ✓?</text>
    </g>
  </svg>`,
  checkout: `<svg viewBox="0 0 320 112" preserveAspectRatio="xMidYMid slice">
    <rect x="22" y="14" width="150" height="86" rx="10" fill="${B}" stroke="${S}"/>
    <rect x="36" y="28" width="22" height="22" rx="6" fill="${A}" opacity=".2"/><rect x="66" y="31" width="70" height="6" rx="3" fill="${T}" opacity=".5"/><rect x="66" y="42" width="40" height="5" rx="2.5" fill="${S}"/>
    <rect x="36" y="58" width="22" height="22" rx="6" fill="${H}" opacity=".22"/><rect x="66" y="61" width="60" height="6" rx="3" fill="${T}" opacity=".5"/><rect x="66" y="72" width="34" height="5" rx="2.5" fill="${S}"/>
    <rect x="36" y="86" width="122" height="8" rx="4" fill="${A}"/>
    <g font-size="10.5" font-family="var(--font-mono)">
      <rect x="190" y="18" width="110" height="34" rx="8" fill="${B}" stroke="${S}"/><text x="202" y="39" fill="${T}">order A-1041</text>
      <rect x="198" y="60" width="110" height="34" rx="8" fill="${B}" stroke="${R}" stroke-dasharray="3 3"/><text x="210" y="81" fill="${R}">order A-1042</text>
    </g>
  </svg>`,
  status: `<svg viewBox="0 0 320 112" preserveAspectRatio="xMidYMid slice">
    ${[0, 1, 2]
      .map(
        (i) => `<rect x="${20 + i * 98}" y="14" width="88" height="38" rx="8" fill="${B}" stroke="${S}"/>
      <circle cx="${34 + i * 98}" cy="33" r="5" fill="${i === 1 ? R : G}"/><rect x="${45 + i * 98}" y="29" width="44" height="7" rx="3" fill="${T}" opacity=".45"/>`,
      )
      .join("")}
    <rect x="20" y="62" width="284" height="38" rx="8" fill="${B}" stroke="${S}"/>
    <polyline points="30,90 52,86 74,88 96,84 118,87 140,60 152,90 174,86 196,88 218,66 230,89 252,85 274,87 296,84" fill="none" stroke="${A}" stroke-width="2" stroke-linejoin="round"/>
    <g fill="${R}" opacity=".85"><rect x="138" y="94" width="4" height="4" rx="1"/><rect x="144" y="94" width="4" height="4" rx="1"/><rect x="150" y="94" width="4" height="4" rx="1"/><rect x="216" y="94" width="4" height="4" rx="1"/><rect x="222" y="94" width="4" height="4" rx="1"/></g>
  </svg>`,
  board: `<svg viewBox="0 0 320 112" preserveAspectRatio="xMidYMid slice">
    ${[0, 1, 2, 3]
      .map(
        (i) => `<rect x="${16 + i * 76}" y="12" width="68" height="90" rx="8" fill="${S}" opacity=".55"/>
      <rect x="${22 + i * 76}" y="18" width="34" height="5" rx="2.5" fill="${T}" opacity=".5"/>`,
      )
      .join("")}
    <rect x="22" y="30" width="56" height="20" rx="5" fill="${B}" stroke="${S}"/><rect x="22" y="56" width="56" height="20" rx="5" fill="${B}" stroke="${S}"/>
    <rect x="98" y="30" width="56" height="20" rx="5" fill="${B}" stroke="${S}"/>
    <rect x="174" y="30" width="56" height="20" rx="5" fill="${B}" stroke="${A}" stroke-width="1.5"/>
    <rect x="250" y="30" width="56" height="20" rx="5" fill="${B}" stroke="${R}" stroke-dasharray="3 3"/>
    <path d="M232 40h14" stroke="${R}" stroke-width="1.5"/><path d="M156 46c10 18 30 18 40 4" fill="none" stroke="${A}" stroke-width="1.5" stroke-dasharray="3 3"/>
  </svg>`,
  decisions: `<svg viewBox="0 0 320 112" preserveAspectRatio="xMidYMid slice">
    <rect x="20" y="14" width="168" height="40" rx="12" fill="${B}" stroke="${S}"/>
    <text x="34" y="38.5" font-size="11.5" fill="${T}" font-family="var(--font-sans)">Good moment for a backup?</text>
    <g font-size="10" font-family="var(--font-mono)" fill="${T}">
      <text x="34" y="74">yes</text><rect x="64" y="66" width="110" height="9" rx="4.5" fill="${S}"/><rect x="64" y="66" width="22" height="9" rx="4.5" fill="${T}" opacity=".6"/>
      <text x="34" y="94">no</text><rect x="64" y="86" width="110" height="9" rx="4.5" fill="${S}"/><rect x="64" y="86" width="88" height="9" rx="4.5" fill="${A}"/>
    </g>
    <rect x="206" y="14" width="96" height="88" rx="12" fill="${B}" stroke="${S}"/>
    <path d="M222 44h64M222 58h50M222 72h58" stroke="${S}" stroke-width="6" stroke-linecap="round"/>
    <circle cx="286" cy="88" r="8" fill="${H}" opacity=".85"/><path d="m282.5 88 2.5 2.5 4.5-5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  </svg>`,
};
