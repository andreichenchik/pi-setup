import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAskUserResult,
  isQuestionAnswered,
  normalizeQuestions,
  prepareAskUserArguments,
} from "../lib/ask-user.js";

describe("normalizeQuestions", () => {
  it("normalizes defaults and option values", () => {
    const questions = normalizeQuestions([
      {
        id: "implementation approach",
        prompt: "Which implementation should I use?",
        options: [{ label: "Minimal" }, { value: "rich", label: "Rich UI", description: "Custom multi-question TUI." }],
      },
    ]);

    assert.deepEqual(questions, [
      {
        id: "implementation_approach",
        label: "Q1",
        prompt: "Which implementation should I use?",
        options: [
          { value: "Minimal", label: "Minimal" },
          { value: "rich", label: "Rich UI", description: "Custom multi-question TUI." },
        ],
        allowCustomAnswer: true,
        multiline: true,
        required: true,
      },
    ]);
  });

  it("rejects empty question batches", () => {
    assert.throws(() => normalizeQuestions([]), /at least one question/);
  });
});

describe("prepareAskUserArguments", () => {
  it("converts obvious singular question calls into the public questions shape", () => {
    assert.deepEqual(
      prepareAskUserArguments({
        question: "Pick an approach",
        options: [{ label: "Minimal" }],
      }),
      {
        question: "Pick an approach",
        options: [{ label: "Minimal" }],
        questions: [
          {
            id: "question",
            label: undefined,
            prompt: "Pick an approach",
            description: undefined,
            options: [{ label: "Minimal" }],
            allowCustomAnswer: undefined,
            multiline: undefined,
            required: undefined,
          },
        ],
      },
    );
  });
});

describe("isQuestionAnswered", () => {
  it("requires non-blank answers for required questions", () => {
    assert.equal(isQuestionAnswered({ required: true }, undefined), false);
    assert.equal(isQuestionAnswered({ required: true }, { value: "   " }), false);
    assert.equal(isQuestionAnswered({ required: true }, { value: "Use the rich UI" }), true);
  });

  it("accepts missing answers for optional questions", () => {
    assert.equal(isQuestionAnswered({ required: false }, undefined), true);
  });
});

describe("formatAskUserResult", () => {
  it("formats selected, custom, and free-text answers", () => {
    const text = formatAskUserResult({
      cancelled: false,
      questions: [
        { id: "approach", label: "Approach", prompt: "Which implementation should I use?" },
        { id: "notes", label: "Notes", prompt: "Any constraints?" },
      ],
      answers: [
        { id: "approach", value: "rich", label: "Rich UI", kind: "choice", optionIndex: 2 },
        { id: "notes", value: "Keep it simple", label: "Keep it simple", kind: "text" },
      ],
    });

    assert.match(text, /Approach: Which implementation should I use\?/);
    assert.match(text, /Answer: selected 2\. Rich UI/);
    assert.match(text, /Notes: Any constraints\?/);
    assert.match(text, /Type: free-text answer/);
  });

  it("formats cancellation as an instruction not to assume answers", () => {
    assert.match(
      formatAskUserResult({ cancelled: true, questions: [], answers: [] }),
      /Do not assume answers/,
    );
  });
});
