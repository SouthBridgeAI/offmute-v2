import { describe, it, expect } from "vitest";
import {
  namesMatch,
  evidenceInTranscript,
  findSelfIntroductions,
  adjudicate,
} from "../src/diarize/identify2.js";

describe("namesMatch", () => {
  it("matches exact, case-insensitive, and subset names", () => {
    expect(namesMatch("Rishi", "rishi")).toBe(true);
    expect(namesMatch("Rishi", "Rishi Olickel")).toBe(true);
    expect(namesMatch("Hanjun Kim", "Hanjun")).toBe(true);
    expect(namesMatch("Rishi", "Matthew")).toBe(false);
    expect(namesMatch("", "Rishi")).toBe(false);
  });

  it("tolerates one-edit spelling variants of longer name tokens", () => {
    // Different models render the same heard name differently.
    expect(namesMatch("Rishi", "Hrishi Olickel")).toBe(true);
    expect(namesMatch("Hanjin Kim", "Hanjun Kim")).toBe(true);
    // Short tokens must match exactly — Jay is not Ray.
    expect(namesMatch("Jay", "Ray")).toBe(false);
    expect(namesMatch("Anna", "Alma")).toBe(false);
  });
});

describe("evidenceInTranscript", () => {
  const transcript = "hi everyone im ang li co founder and ceo of simular";
  it("accepts verbatim (normalized) quotes and rejects fabrications", () => {
    expect(evidenceInTranscript("I'm Ang Li, co-founder and CEO", transcript)).toBe(true);
    expect(evidenceInTranscript("my name is Bob and I run things", transcript)).toBe(false);
    expect(evidenceInTranscript("im ang", transcript)).toBe(false); // too short to count
    expect(evidenceInTranscript(undefined, transcript)).toBe(false);
  });
});

describe("findSelfIntroductions", () => {
  it("extracts stated names and skips non-name phrases", () => {
    const intros = findSelfIntroductions([
      { speaker: "Speaker A", text: "Hey everybody, I'm Hanjun Kim, a strategy professor." },
      { speaker: "Speaker B", text: "I'm so happy for you guys." },
      { speaker: "Speaker C", text: "My name is Elsa. She's French." },
    ]);
    expect(intros).toHaveLength(2);
    expect(intros[0]).toMatchObject({ speakerId: "Speaker A", introducedName: "Hanjun Kim" });
    expect(intros[1]).toMatchObject({ speakerId: "Speaker C", introducedName: "Elsa" });
  });
});

describe("adjudicate", () => {
  const transcript = "hi im ang li ceo of simular and before that i said 5 percent";

  it("adopts agreement, preferring the fuller name", () => {
    const d = adjudicate("Speaker A", { name: "Ang" }, { name: "Ang Li" }, transcript, undefined);
    expect(d.outcome).toBe("agreed");
    expect(d.finalName).toBe("Ang Li");
  });

  it("takes the only available name when the other pass abstains", () => {
    const d = adjudicate("Speaker A", { name: "Ang Li" }, { name: "" }, transcript, undefined);
    expect(d.outcome).toBe("a-only");
    expect(d.finalName).toBe("Ang Li");
  });

  it("breaks disagreements by verifiable evidence", () => {
    const d = adjudicate(
      "Speaker A",
      { name: "Moderator", evidence: "welcome to the totally invented show" },
      { name: "Ang Li", evidence: "im ang li ceo of simular" },
      transcript,
      undefined,
    );
    expect(d.outcome).toBe("evidence-break");
    expect(d.finalName).toBe("Ang Li");
  });

  it("keeps the label generic when neither disagreeing claim verifies", () => {
    const d = adjudicate(
      "Speaker A",
      { name: "Alice", evidence: "fabricated quote one here" },
      { name: "Bob", evidence: "fabricated quote two here" },
      transcript,
      undefined,
    );
    expect(d.outcome).toBe("kept-generic");
    expect(d.finalName).toBeUndefined();
  });

  it("lets a corroborated self-introduction override both passes", () => {
    const d = adjudicate(
      "Speaker A",
      { name: "Moderator" },
      { name: "Host" },
      transcript,
      "Ang Li",
      true, // roster/known speakers mention Ang Li
    );
    expect(d.outcome).toBe("tripwire");
    expect(d.finalName).toBe("Ang Li");
  });

  it("does not let an uncorroborated intro override both passes (false-positive guard)", () => {
    // "This is Reddit, man" style extraction: no model and no roster backs "Reddit".
    const d = adjudicate(
      "Speaker A",
      { name: "Moderator", evidence: "im ang li ceo of simular" },
      { name: "Host", evidence: "fabricated quote" },
      transcript,
      "Reddit",
      false,
    );
    expect(d.outcome).not.toBe("tripwire");
    expect(d.finalName).not.toBe("Reddit");
  });

  it("still prefers a model answer the intro corroborates", () => {
    const d = adjudicate(
      "Speaker A",
      { name: "Ang Li" },
      { name: "Moderator" },
      transcript,
      "Ang Li",
      false,
    );
    expect(d.outcome).toBe("tripwire");
    expect(d.finalName).toBe("Ang Li");
  });

  it("single mode trusts pass A", () => {
    const d = adjudicate("Speaker A", { name: "Ang Li" }, undefined, transcript, undefined);
    expect(d.outcome).toBe("a-only");
    expect(d.finalName).toBe("Ang Li");
  });
});

describe("identifySpeakersV2 name uniqueness", () => {
  it("demotes duplicate final names to generic (one person cannot be two voices)", async () => {
    // Pass A and pass B swap a name pair; per-speaker resolution would yield the same
    // person twice — the coherence check must demote both equal-strength claims.
    const mkPass = (map: Record<string, string>) => ({
      speakers: Object.entries(map).map(([id, name]) => ({
        id,
        name,
        confidence: "high",
        evidence: "fabricated either way",
      })),
      reasoning: "",
    });
    const passes = [
      mkPass({ "Speaker A": "Hrishi", "Speaker B": "Jay" }),
      mkPass({ "Speaker A": "Jay", "Speaker B": "Hrishi Olickel" }),
    ];
    let call = 0;
    const fakeClient = {
      chatJson: async () => ({ data: passes[call++ % 2], raw: "", error: undefined }),
    };
    const { identifySpeakersV2 } = await import("../src/diarize/identify2.js");
    const handle = (m: string) => ({
      client: fakeClient as never,
      model: m,
      provider: m,
    });
    const res = await identifySpeakersV2(
      handle("model-a"),
      handle("model-b"),
      [
        { speaker: "Speaker A", text: "hello there" },
        { speaker: "Speaker B", text: "hi yourself" },
      ],
      [{ id: "Speaker A" }, { id: "Speaker B" }],
      { roster: "(none)" },
    );
    // Neither speaker keeps a name — the binding is genuinely disputed.
    expect(Object.keys(res.nameMap)).toHaveLength(0);
    expect(res.decisions.every((d) => !d.finalName)).toBe(true);
  });
});
