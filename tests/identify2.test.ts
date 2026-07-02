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

  it("lets a self-introduction override both passes", () => {
    const d = adjudicate(
      "Speaker A",
      { name: "Moderator" },
      { name: "Host" },
      transcript,
      "Ang Li",
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
