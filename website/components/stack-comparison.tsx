import type { ReactNode } from "react";
import "./stack-comparison.css";

type Cast = "A" | "B" | "C";
const names = {
  A: "add library",
  B: "add component",
  C: "use library in component",
};

function Change({
  id,
  x,
  y,
  status,
  landed = false,
}: {
  id: Cast;
  x: number;
  y: number;
  status?: "approved" | "review";
  landed?: boolean;
}) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      className={`graph-change graph-change-${id}${landed ? " graph-landed" : ""}`}
    >
      <title>{`${id} · ${names[id]}${landed ? ", landed" : status === "approved" ? ", approved" : status === "review" ? ", in review" : ""}`}</title>
      <rect x="5" y="5" width="128" height="50" className="graph-card-shadow" />
      <rect width="128" height="50" className="graph-card-face" />
      <path d="M14 18h62m-62 14h91" className="graph-code" />
      <text
        x={landed ? 64 : 0}
        y={landed ? 64 : -9}
        textAnchor={landed ? "middle" : "start"}
        className="graph-letter"
      >
        {id}
      </text>
      {status === "approved" && (
        <g className="graph-approved" transform="translate(119 -2)">
          <rect x="-11" y="-11" width="22" height="22" />
          <path d="m-5 0 3 4 7-8" />
        </g>
      )}
      {status === "review" && (
        <g className="graph-review" transform="translate(119 -2)">
          <rect x="-11" y="-9" width="22" height="18" />
          <text textAnchor="middle" y="4">
            …
          </text>
        </g>
      )}
    </g>
  );
}

function Main({ children }: { children?: ReactNode }) {
  return (
    <g className="graph-main">
      <rect
        x="14"
        y="308"
        width="284"
        height="80"
        className="graph-main-shadow"
      />
      <rect x="8" y="302" width="284" height="80" className="graph-main-face" />
      <rect
        x="8"
        y="302"
        width="284"
        height="18"
        className="graph-main-header"
      />
      <text x="19" y="315" className="graph-main-label">
        main
      </text>
      {children}
    </g>
  );
}

function Edge({
  d,
  marker,
  manual = false,
  muted = false,
}: {
  d: string;
  marker: string;
  manual?: boolean;
  muted?: boolean;
}) {
  return (
    <path
      d={d}
      className={`graph-edge${manual ? " graph-manual" : ""}${muted ? " graph-muted-edge" : ""}`}
      markerEnd={`url(#${marker}-${manual ? "manual" : "parent"})`}
    />
  );
}

function Frame({
  id,
  step,
  caption,
  description,
  children,
}: {
  id: string;
  step: number;
  caption: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <figure className="stack-frame">
      <svg
        viewBox="0 0 300 394"
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
      >
        <title id={`${id}-title`}>{caption}</title>
        <desc id={`${id}-description`}>{description}</desc>
        <defs>
          <marker
            id={`${id}-parent`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path
              d="M0 1 9 5 0 9"
              fill="none"
              stroke="var(--blue)"
              strokeWidth="1.5"
            />
          </marker>
          <marker
            id={`${id}-manual`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path
              d="M0 1 9 5 0 9"
              fill="none"
              stroke="var(--red)"
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        {children}
      </svg>
      <figcaption>
        <span>{step.toString().padStart(2, "0")}</span>
        {caption}
      </figcaption>
    </figure>
  );
}

function EmptySlot() {
  return (
    <g className="graph-empty-slot">
      <rect x="86" y="108" width="128" height="50" />
    </g>
  );
}

export function StackComparison() {
  return (
    <div className="stack-comparison">
      <div className="stack-cast" aria-label="The three changes">
        {(["A", "B", "C"] as Cast[]).map((id) => (
          <div className="stack-cast-item" key={id}>
            <svg
              viewBox="0 0 48 32"
              aria-hidden="true"
              className={`cast-swatch cast-swatch-${id}`}
            >
              <rect
                x="4"
                y="4"
                width="42"
                height="26"
                className="cast-shadow"
              />
              <rect width="42" height="26" className="cast-face" />
              <path d="M8 9h17M8 17h26" />
            </svg>
            <span>
              <b>{id}</b> / {names[id]}
            </span>
          </div>
        ))}
      </div>
      <p className="stack-scroll-hint">
        Scroll sideways to follow both stories.
      </p>
      <div
        className="stack-scroll"
        tabIndex={0}
        role="region"
        aria-label="Compare four single-stack steps with three Cabaret steps. Scroll horizontally on smaller screens."
      >
        <div className="stack-strips">
          <section
            className="comparison-strip"
            aria-labelledby="single-stack-label"
          >
            <div className="strip-heading">
              <h4 id="single-stack-label">With old-age stacks</h4>
            </div>
            <div className="strip-frames">
              <Frame
                id="single-1"
                step={1}
                caption="You stack A, then B, then C."
                description="C builds on B, B builds on A, and A builds on main, all in a vertical stack. B depends on A only because of its position in the stack."
              >
                <Main />
                <Edge marker="single-1" d="M150 70V103" />
                <Edge marker="single-1" d="M150 158V191" />
                <Edge marker="single-1" d="M150 246V298" />
                <Change id="C" x={86} y={20} />
                <Change id="B" x={86} y={108} />
                <Change id="A" x={86} y={196} />
              </Frame>
              <Frame
                id="single-2"
                step={2}
                caption="B is approved, but it’s stuck behind A."
                description="B is approved, with a checkmark, but has a blocked stamp because its parent A is still in review. C still sits on B."
              >
                <Main />
                <Edge marker="single-2" d="M150 70V103" />
                <Edge marker="single-2" d="M150 158V191" />
                <Edge marker="single-2" d="M150 246V298" />
                <Change id="C" x={86} y={20} />
                <Change id="B" x={86} y={108} status="approved" />
                <Change id="A" x={86} y={196} status="review" />
              </Frame>
              <Frame
                id="single-3"
                step={3}
                caption="Rebase B out of the stack to land it."
                description="A stays in review. A dashed curved arrow labeled rebase pulls B from its old position to main. B appears faded with its approval check inside main; C is still attached to the old stack."
              >
                <Main>
                  <Change id="B" x={158} y={326} status="approved" landed />
                </Main>
                <Edge marker="single-3" d="M150 70V103" muted />
                <Edge marker="single-3" d="M150 158V191" muted />
                <Edge marker="single-3" d="M150 246V298" />
                <EmptySlot />
                <Change id="C" x={86} y={20} />
                <Change id="A" x={86} y={196} status="review" />
                <Edge
                  marker="single-3"
                  d="M219 133C286 133 287 190 280 239S258 289 230 322"
                  manual
                />
                <text
                  className="graph-rebase-label"
                  x="241"
                  y="258"
                  textAnchor="middle"
                >
                  rebase
                </text>
              </Frame>
              <Frame
                id="single-4"
                step={4}
                caption="Rebase C onto A."
                description="B has landed in main. Its old position is an empty gap between C and A. A second dashed curved arrow, labeled rebase again, shows the manual repair connecting C to A."
              >
                <Main>
                  <Change id="B" x={158} y={326} status="approved" landed />
                </Main>
                <Edge marker="single-4" d="M150 70V103" muted />
                <Edge marker="single-4" d="M150 158V191" muted />
                <Edge marker="single-4" d="M150 246V298" />
                <EmptySlot />
                <Change id="C" x={86} y={20} />
                <Change id="A" x={86} y={196} status="review" />
                <Edge
                  marker="single-4"
                  d="M218 45C282 54 282 172 219 217"
                  manual
                />
                <text
                  className="graph-rebase-label"
                  x="253"
                  y="126"
                  textAnchor="middle"
                >
                  <tspan x="253">rebase</tspan>
                  <tspan x="253" dy="17">
                    again
                  </tspan>
                </text>
              </Frame>
            </div>
          </section>
          <section
            className="comparison-strip cabaret-strip"
            aria-labelledby="cabaret-stack-label"
          >
            <div className="strip-heading">
              <h4 id="cabaret-stack-label">With Cabaret</h4>
            </div>
            <div className="strip-frames">
              <Frame
                id="multi-1"
                step={1}
                caption="C sits on both A and B."
                description="A and B sit side by side, each directly on main. C has two distinct arrows, one to A and one to B, because it needs both independent changes."
              >
                <Main />
                <Edge marker="multi-1" d="M124 70 78 191" />
                <Edge marker="multi-1" d="M176 70 222 191" />
                <Edge marker="multi-1" d="M78 246V298" />
                <Edge marker="multi-1" d="M222 246V298" />
                <Change id="C" x={86} y={20} />
                <Change id="A" x={14} y={196} />
                <Change id="B" x={158} y={196} />
                <text
                  className="graph-parent-label"
                  x="150"
                  y="132"
                  textAnchor="middle"
                >
                  <tspan x="150">C has two</tspan>
                  <tspan x="150" dy="17">
                    parents, A and B.
                  </tspan>
                </text>
              </Frame>
              <Frame
                id="multi-2"
                step={2}
                caption="B is approved, and now we can land it with zero rebases."
                description="B lands directly into main with its checkmark. A remains in review in the same position, and C stays in place. C now points to A and main. No manual rebase arrows are needed."
              >
                <Main>
                  <Change id="B" x={158} y={326} status="approved" landed />
                </Main>
                <Edge marker="multi-2" d="M124 70 78 191" />
                <Edge marker="multi-2" d="M176 70 222 298" />
                <Edge marker="multi-2" d="M78 246V298" />
                <Change id="C" x={86} y={20} />
                <Change id="A" x={14} y={196} status="review" />
                <text
                  className="graph-parent-label"
                  x="241"
                  y="183"
                  textAnchor="middle"
                >
                  <tspan x="241">B is now</tspan>
                  <tspan x="241" dy="17">
                    landed in main
                  </tspan>
                </text>
              </Frame>
              <Frame
                id="multi-3"
                step={3}
                caption="No rebases are needed in the aftermath of B's landing, either. Now A can be landed, then C, after they are approved."
                description="A is approved and joins B inside main. C is then approved and lands directly into main, shown by the straight landing arrow. There is no manual dependency repair."
              >
                <Main>
                  <Change id="A" x={14} y={326} status="approved" landed />
                  <Change id="B" x={158} y={326} status="approved" landed />
                </Main>
                <Edge marker="multi-3" d="M150 70V298" />
                <Change id="C" x={86} y={20} status="approved" />
                <text className="graph-parent-label" x="168" y="145">
                  <tspan x="168">No rebases needed!</tspan>
                </text>
              </Frame>
            </div>
          </section>
        </div>
      </div>
      <div className="stack-finish">
        <span className="stack-stamp">NO CRAZY REBASES</span>
        <p className="stack-takeaway">
          By letting your stack branch out like a tree instead of forcing it into a line, a change lands when it's ready, without fussy rebases.
        </p>
      </div>
    </div>
  );
}
