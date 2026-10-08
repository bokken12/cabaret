import type { ReactNode } from "react";
import "./feature-illustrations.css";

function Illustration({ id, title, description, children, caption }: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
  caption?: string;
}) {
  return (
    <figure className="feature-illustration">
      <span className="fi-scroll-hint" aria-hidden="true">Scroll sideways to explore the illustration.</span>
      <div className="fi-scroll" role="region" aria-label={title} tabIndex={0}>
      <svg viewBox="0 0 720 370" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{description}</desc>
        {children}
      </svg>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function Check({ x, y }: { x: number; y: number }) {
  return <path d={`M${x} ${y + 5} l5 5 l10 -12`} className="fi-check" />;
}

function Arrow({ x, y }: { x: number; y: number }) {
  return <path d={`M${x} ${y} h30 m-7 -6 l7 6 l-7 6`} className="fi-line" />;
}

function CodeBlock({ x, y, changed = false }: { x: number; y: number; changed?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width="146" height="47" className={changed ? "fi-highlight" : "fi-wash"} />
      <path d={`M${x + 13} ${y + 16} h62 m-62 13 h91`} className={changed ? "fi-code fi-red" : "fi-code"} />
      {changed ? <text x={x + 120} y={y + 29} className="fi-plus">+</text> : <Check x={x + 118} y={y + 19} />}
    </g>
  );
}

export function ReviewMemoryIllustration() {
  return (
    <Illustration id="review-memory" title="Your review picks up where you left off"
      description="Three stages: two code blocks are reviewed; after an update and a clean rebase, those blocks keep their checkmarks and a new block appears; the next review shows only the new block.">
      <text x="36" y="35" className="fi-label">01 / REVIEWED</text>
      <text x="278" y="35" className="fi-label">02 / UPDATED + REBASED</text>
      <text x="526" y="35" className="fi-label">03 / YOUR NEXT REVIEW</text>
      <rect x="42" y="71" width="182" height="229" className="fi-shadow" />
      <rect x="36" y="65" width="182" height="229" className="fi-paper" />
      <text x="54" y="94" className="fi-mono">feature.ts</text>
      <path d="M36 110 H218" className="fi-rule" />
      <CodeBlock x={54} y={128} />
      <CodeBlock x={54} y={186} />
      <text x="54" y="272" className="fi-label">ALL CAUGHT UP</text>
      <Arrow x={232} y={178} />
      <rect x="284" y="71" width="182" height="229" className="fi-shadow" />
      <rect x="278" y="65" width="182" height="229" className="fi-paper" />
      <text x="296" y="94" className="fi-mono">feature.ts</text>
      <path d="M278 110 H460" className="fi-rule" />
      <CodeBlock x={296} y={128} />
      <CodeBlock x={296} y={186} />
      <CodeBlock x={296} y={244} changed />
      <Arrow x={476} y={178} />
      <rect x="526" y="121" width="182" height="124" className="fi-red-fill" />
      <rect x="520" y="115" width="182" height="124" className="fi-paper" />
      <text x="538" y="144" className="fi-mono">feature.ts</text>
      <path d="M520 160 H702" className="fi-rule" />
      <CodeBlock x={538} y={178} changed />
      <g transform="rotate(-5 611 281)">
        <rect x="543" y="260" width="136" height="34" className="fi-stamp" />
        <text x="611" y="282" textAnchor="middle" className="fi-label fi-red">JUST THE NEW BIT</text>
      </g>
      <path d="M296 319 v9 h146 v-9" className="fi-line" />
      <text x="369" y="352" textAnchor="middle" className="fi-mono">Never look at the blue checkmarks again!</text>
    </Illustration>
  );
}

export function GitIllustration() {
  return (
    <Illustration id="shared-git" title="Two workflows, one Git repository"
      description="You review the add-search change in Cabaret while a teammate reviews the same change in GitHub. Both interfaces connect to the same Git repository."
      >
      <text x="30" y="32" className="fi-label">YOU, IN CABARET</text>
      <text x="434" y="32" className="fi-label">YOUR TEAMMATE, IN GITHUB</text>
      <rect x="36" y="60" width="256" height="178" className="fi-shadow" />
      <rect x="30" y="54" width="256" height="178" className="fi-paper" />
      <rect x="30" y="54" width="256" height="37" className="fi-blue-fill" />
      <text x="47" y="78" className="fi-mono fi-cream">CABARET's new-age review</text>
      <text x="48" y="118" className="fi-mono">add-search</text>
      <path d="M48 132 H268" className="fi-rule" />
      <text x="48" y="155" className="fi-mono">src/search.ts</text>
      <path d="M49 176 h112 m-112 14 h159" className="fi-code" />
      <Check x={243} y={175} />
      <text x="48" y="216" className="fi-label">REVIEWED</text>
      <rect x="440" y="60" width="256" height="178" className="fi-shadow" />
      <rect x="434" y="54" width="256" height="178" className="fi-paper" />
      <path d="M434 91 H690" className="fi-rule" />
      <circle cx="451" cy="72" r="3" className="fi-blue-fill" />
      <circle cx="464" cy="72" r="3" className="fi-blue-fill" />
      <text x="478" y="78" className="fi-mono" textLength="197" lengthAdjust="spacingAndGlyphs">GitHub's old-age review</text>
      <text x="452" y="118" className="fi-mono">add-search</text>
      <path d="M452 132 H672" className="fi-rule" />
      <circle cx="463" cy="157" r="10" className="fi-wash" />
      <text x="484" y="162" className="fi-mono">Looks good to me.</text>
      <rect x="452" y="182" width="122" height="31" className="fi-wash" />
      <Check x={463} y={191} />
      <text x="489" y="203" className="fi-label">APPROVED</text>
      <path d="M158 244 V302 H264 M562 244 V302 H456" className="fi-line" />
      <path d="M152 252 l6 -8 l6 8 M258 296 l6 6 l-6 6 M556 252 l6 -8 l6 8 M462 296 l-6 6 l6 6" className="fi-line" />
      <rect x="272" y="264" width="176" height="76" className="fi-red-fill" />
      <path d="M296 283 v35 m0 -18 q25 0 25 -17" className="fi-light-line" />
      <circle cx="296" cy="283" r="4" className="fi-cream-fill" />
      <circle cx="296" cy="318" r="4" className="fi-cream-fill" />
      <circle cx="321" cy="283" r="4" className="fi-cream-fill" />
      <text x="340" y="298" className="fi-display fi-cream">GIT</text>
      <text x="340" y="321" className="fi-label fi-cream">SAME REPO</text>
    </Illustration>
  );
}

export function EditorIllustration() {
  return (
    <Illustration id="editor-review" title="Fix and comment right in your editor"
      description="A simplified editor shows a greeting typo corrected from Helo to Hello, followed by an inline TODO asking to handle an empty name. Both actions happen in the same file."
    >
      <rect x="38" y="35" width="642" height="277" className="fi-blue-fill" />
      <rect x="30" y="27" width="642" height="277" className="fi-paper" />
      <rect x="30" y="27" width="642" height="40" className="fi-blue-fill" />
      <path d="M77 67 V273 M30 106 H672 M30 273 H672" className="fi-rule" />
      <text x="95" y="92" className="fi-mono">src/greeting.ts</text>
      <text x="47" y="136" className="fi-mono fi-muted">12</text>
      <text x="47" y="165" className="fi-mono fi-muted">13</text>
      <text x="47" y="197" className="fi-mono fi-muted">13</text>
      <text x="47" y="233" className="fi-mono fi-muted">14</text>
      <text x="47" y="259" className="fi-mono fi-muted">15</text>
      <text x="95" y="136" className="fi-editor-code">function greet(name: string) &#123;</text>
      <rect x="78" y="145" width="593" height="28" className="fi-wash" />
      <text x="94" y="165" className="fi-editor-code fi-muted">−  return `Helo, $&#123;name&#125;`;</text>
      <path d="M127 160 H397" className="fi-rule" />
      <rect x="78" y="177" width="593" height="29" className="fi-highlight" />
      <text x="94" y="197" className="fi-editor-code">+  return `Hello, $&#123;name&#125;`;</text>
      <text x="95" y="233" className="fi-editor-code fi-red">   // TODO: handle an empty name</text>
      <rect x="482" y="217" width="8" height="20" className="fi-red-fill" />
      <text x="95" y="259" className="fi-editor-code">&#125;</text>
      <g transform="rotate(-4 583 190)">
        <rect x="530" y="174" width="106" height="31" className="fi-stamp" />
        <text x="583" y="195" textAnchor="middle" className="fi-label fi-red">FIX IT HERE</text>
      </g>
      <path d="M335 241 v95 h90" className="fi-line" />
      <text x="438" y="342" className="fi-mono">A comment is just code!</text>
    </Illustration>
  );
}
