import { describe, it, expect } from "vitest";
import { parseDescription } from "../src/transcribe/describe.js";

// The description reaches every chunk's prompt and the terminal; the prompt's own section
// headings, which models repeat, shouldn't come with it.
describe("parseDescription", () => {
  it("drops the section headings the prompt shows", () => {
    expect(
      parseDescription(
        "DESCRIPTION\nTwo founders at a cafe.\n---\nROSTER\n- Speaker A: low voice",
      ),
    ).toEqual({
      description: "Two founders at a cafe.",
      roster: "- Speaker A: low voice",
    });
  });

  it("drops them in markdown, or as a label before a colon", () => {
    expect(parseDescription("**DESCRIPTION:** A call.\n---\n## ROSTER\n- A")).toEqual({
      description: "A call.",
      roster: "- A",
    });
  });

  it("keeps prose that only starts with the word", () => {
    expect(
      parseDescription("Description of the call: two people.\n---\n- A").description,
    ).toBe("Description of the call: two people.");
  });

  it("keeps a reply without the separator whole, with no roster", () => {
    expect(parseDescription("Just one paragraph.")).toEqual({
      description: "Just one paragraph.",
      roster: "(no explicit roster)",
    });
  });
});
