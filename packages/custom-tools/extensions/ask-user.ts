import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatAskUserResult,
  isQuestionAnswered,
  normalizeQuestions,
  prepareAskUserArguments,
} from "../lib/ask-user.js";

interface AskUserOption {
  value: string;
  label: string;
  description?: string;
}

interface AskUserQuestion {
  id: string;
  label: string;
  prompt: string;
  description?: string;
  options: AskUserOption[];
  allowCustomAnswer: boolean;
  multiline: boolean;
  required: boolean;
}

type AnswerKind = "choice" | "custom" | "text";

interface AskUserAnswer {
  id: string;
  value: string;
  label: string;
  kind: AnswerKind;
  optionIndex?: number;
}

interface AskUserResult {
  cancelled: boolean;
  questions: AskUserQuestion[];
  answers: AskUserAnswer[];
}

type RenderOption = AskUserOption & { isCustom?: boolean };

const AskUserOptionSchema = Type.Object({
  value: Type.Optional(Type.String({ description: "Stable value returned to the model. Defaults to label." })),
  label: Type.String({ description: "Option label shown to the user." }),
  description: Type.Optional(Type.String({ description: "Short explanation shown below the option label." })),
});

const AskUserQuestionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable identifier for this question, e.g. 'approach' or 'database'. Defaults to q1, q2, etc." })),
  label: Type.Optional(Type.String({ description: "Short label for navigation, e.g. 'Scope' or 'Database'." })),
  prompt: Type.String({ description: "Question text shown to the user." }),
  description: Type.Optional(Type.String({ description: "Optional context that helps the user answer." })),
  options: Type.Optional(Type.Array(AskUserOptionSchema, { description: "Choices the user can select from." })),
  allowCustomAnswer: Type.Optional(
    Type.Boolean({ description: "Whether to add a free-text answer option when choices are provided. Default: true." }),
  ),
  multiline: Type.Optional(Type.Boolean({ description: "Whether free-text answers can contain newlines. Default: true." })),
  required: Type.Optional(Type.Boolean({ description: "Whether the user must answer this question before submitting. Default: true." })),
});

const AskUserParams = Type.Object({
  title: Type.Optional(Type.String({ description: "Title shown at the top of the question UI." })),
  questions: Type.Array(AskUserQuestionSchema, {
    minItems: 1,
    description: "Questions to ask in one batch. Batch related clarifications instead of asking one at a time.",
  }),
});

/**
 * Interactive multi-question UI for the ask_user tool.
 *
 * Supports choice questions, choice questions with a custom free-text option,
 * and text-only questions. The result is structured for tool details and also
 * formatted into a concise text summary for the model.
 */
class AskUserComponent implements Component, Focusable {
  private readonly title: string;
  private readonly questions: AskUserQuestion[];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly onDone: (result: AskUserResult) => void;
  private readonly editor: Editor;
  private readonly answers = new Map<string, AskUserAnswer>();
  private readonly drafts = new Map<string, string>();
  private currentIndex = 0;
  private optionIndex = 0;
  private editingCustom = false;
  private showingConfirmation = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private _focused = false;

  constructor(title: string | undefined, questions: AskUserQuestion[], tui: TUI, theme: Theme, onDone: (result: AskUserResult) => void) {
    this.title = title?.trim() || "Questions";
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;

    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s: string) => theme.fg("accent", s),
        selectedText: (s: string) => theme.fg("accent", s),
        description: (s: string) => theme.fg("muted", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        noMatch: (s: string) => theme.fg("warning", s),
      },
    };

    this.editor = new Editor(tui, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      if (this.isEditingText()) this.drafts.set(this.currentQuestion().id, this.editor.getText());
      this.refresh();
    };

    this.syncEditorForCurrentQuestion();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.showingConfirmation) {
      if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
        this.onDone(this.buildResult(false));
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
        this.showingConfirmation = false;
        this.refresh();
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.editingCustom) {
        this.editingCustom = false;
        this.syncEditorForCurrentQuestion();
        this.refresh();
        return;
      }
      this.onDone(this.buildResult(true));
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.navigateTo((this.currentIndex + 1) % this.questions.length);
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.navigateTo((this.currentIndex - 1 + this.questions.length) % this.questions.length);
      return;
    }

    if (this.isEditingText()) {
      this.handleTextInput(data);
      return;
    }

    this.handleChoiceInput(data);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const boxWidth = Math.max(32, Math.min(width, 120));
    const contentWidth = Math.max(1, boxWidth - 4);
    const horizontal = (count: number) => "─".repeat(Math.max(0, count));
    const padToWidth = (line: string) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    const boxLine = (content = "", leftPad = 2) => {
      const maxTextWidth = Math.max(1, boxWidth - leftPad - 3);
      const clipped = truncateToWidth(content, maxTextWidth);
      const padded = " ".repeat(leftPad) + clipped;
      const rightPad = Math.max(0, boxWidth - visibleWidth(padded) - 2);
      return padToWidth(th.fg("borderMuted", "│") + padded + " ".repeat(rightPad) + th.fg("borderMuted", "│"));
    };

    const lines: string[] = [];
    const question = this.currentQuestion();
    const answer = this.answers.get(question.id);

    lines.push(padToWidth(th.fg("borderMuted", "╭" + horizontal(boxWidth - 2) + "╮")));
    lines.push(boxLine(`${th.fg("accent", th.bold(this.title))} ${th.fg("dim", `(${this.currentIndex + 1}/${this.questions.length})`)}`));
    lines.push(boxLine(this.renderProgress()));
    lines.push(padToWidth(th.fg("borderMuted", "├" + horizontal(boxWidth - 2) + "┤")));

    lines.push(boxLine(`${th.fg("accent", th.bold(question.label))}: ${th.fg("text", question.prompt)}`));
    if (question.description) {
      for (const line of wrapTextWithAnsi(th.fg("muted", question.description), contentWidth)) {
        lines.push(boxLine(line));
      }
    }
    lines.push(boxLine());

    if (this.isEditingText()) {
      lines.push(...this.renderEditorLines(boxLine, contentWidth));
    } else {
      lines.push(...this.renderOptionLines(boxLine, question));
      if (answer) {
        lines.push(boxLine());
        lines.push(boxLine(th.fg("success", "Current answer: ") + th.fg("text", answer.label)));
      }
    }

    lines.push(boxLine());
    lines.push(padToWidth(th.fg("borderMuted", "├" + horizontal(boxWidth - 2) + "┤")));
    lines.push(boxLine(this.footerText()));
    if (this.showingConfirmation) lines.push(boxLine(th.fg("warning", "Submit all answers? Enter/y confirms, Esc/n returns.")));
    lines.push(padToWidth(th.fg("borderMuted", "╰" + horizontal(boxWidth - 2) + "╯")));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private handleTextInput(data: string): void {
    const question = this.currentQuestion();
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.saveCurrentTextAnswer();
      this.advanceAfterAnswer();
      return;
    }

    if (matchesKey(data, Key.shift("enter")) && !question.multiline) return;

    this.editor.handleInput(data);
    this.saveCurrentDraft();
    this.refresh();
  }

  private handleChoiceInput(data: string): void {
    const options = this.currentOptions();

    if (matchesKey(data, Key.up)) {
      this.optionIndex = Math.max(0, this.optionIndex - 1);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.optionIndex = Math.min(options.length - 1, this.optionIndex + 1);
      this.refresh();
      return;
    }

    if (data.toLowerCase() === "s" && this.allAnswered()) {
      this.showingConfirmation = true;
      this.refresh();
      return;
    }

    if (!matchesKey(data, Key.enter)) return;

    const selected = options[this.optionIndex];
    const question = this.currentQuestion();
    if (selected?.isCustom) {
      this.editingCustom = true;
      this.syncEditorForCurrentQuestion();
      this.refresh();
      return;
    }

    if (!selected) return;
    this.answers.set(question.id, {
      id: question.id,
      value: selected.value,
      label: selected.label,
      kind: "choice",
      optionIndex: this.optionIndex + 1,
    });
    this.advanceAfterAnswer();
  }

  private renderProgress(): string {
    const th = this.theme;
    return this.questions
      .map((question, index) => {
        const marker = index === this.currentIndex ? "●" : isQuestionAnswered(question, this.answers.get(question.id)) ? "●" : "○";
        const color = index === this.currentIndex ? "accent" : isQuestionAnswered(question, this.answers.get(question.id)) ? "success" : "dim";
        return th.fg(color, marker);
      })
      .join(" ");
  }

  private renderEditorLines(boxLine: (content?: string, leftPad?: number) => string, contentWidth: number): string[] {
    const th = this.theme;
    const question = this.currentQuestion();
    const label = question.options.length > 0 ? "Custom answer:" : "Your answer:";
    const lines = [boxLine(th.fg("muted", label))];
    const editorWidth = Math.max(12, contentWidth - 2);
    const editorLines = this.editor.render(editorWidth);
    for (const line of editorLines) lines.push(boxLine(line, 2));
    return lines;
  }

  private renderOptionLines(boxLine: (content?: string, leftPad?: number) => string, question: AskUserQuestion): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const options = this.currentOptions();

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const selected = i === this.optionIndex;
      const prefix = selected ? th.fg("accent", "> ") : "  ";
      const label = option.isCustom ? `${i + 1}. Type a custom answer.` : `${i + 1}. ${option.label}`;
      lines.push(boxLine(prefix + th.fg(selected ? "accent" : "text", label), 2));
      if (option.description) lines.push(boxLine("   " + th.fg("muted", option.description), 2));
    }

    if (options.length === 0) lines.push(boxLine(th.fg("warning", "No options available; use a free-text question instead.")));
    if (!question.required) lines.push(boxLine(th.fg("dim", "Optional question.")));

    return lines;
  }

  private footerText(): string {
    const th = this.theme;
    if (this.showingConfirmation) return th.fg("dim", "Enter/y confirm • Esc/n back");
    if (this.isEditingText()) {
      const newlineHint = this.currentQuestion().multiline ? " • Shift+Enter newline" : "";
      return th.fg("dim", `Enter save/next${newlineHint} • Tab next • Shift+Tab prev • Esc cancel`);
    }
    const submitHint = this.allAnswered() ? " • s submit" : "";
    return th.fg("dim", `↑↓ select • Enter choose • Tab next • Shift+Tab prev${submitHint} • Esc cancel`);
  }

  private currentQuestion(): AskUserQuestion {
    return this.questions[this.currentIndex];
  }

  private currentOptions(): RenderOption[] {
    const question = this.currentQuestion();
    const options: RenderOption[] = [...question.options];
    if (question.allowCustomAnswer) options.push({ value: "__custom__", label: "Type a custom answer", isCustom: true });
    return options;
  }

  private isEditingText(): boolean {
    return this.currentQuestion().options.length === 0 || this.editingCustom;
  }

  private saveCurrentTextAnswer(): void {
    if (!this.isEditingText()) return;
    const question = this.currentQuestion();
    const value = this.editor.getText();
    this.drafts.set(question.id, value);

    const trimmed = value.trim();
    if (!trimmed && question.required) {
      this.answers.delete(question.id);
      this.refresh();
      return;
    }

    this.answers.set(question.id, {
      id: question.id,
      value: trimmed,
      label: trimmed || "(blank)",
      kind: question.options.length > 0 ? "custom" : "text",
    });
    this.editingCustom = false;
    this.refresh();
  }

  private advanceAfterAnswer(): void {
    if (this.allAnswered()) {
      if (this.currentIndex === this.questions.length - 1) {
        this.showingConfirmation = true;
        this.refresh();
        return;
      }
      this.navigateTo(this.currentIndex + 1);
      return;
    }

    const missingIndex = this.questions.findIndex((question) => !isQuestionAnswered(question, this.answers.get(question.id)));
    this.navigateTo(missingIndex >= 0 ? missingIndex : Math.min(this.currentIndex + 1, this.questions.length - 1));
  }

  private allAnswered(): boolean {
    return this.questions.every((question) => isQuestionAnswered(question, this.answers.get(question.id)));
  }

  private navigateTo(index: number): void {
    if (index < 0 || index >= this.questions.length) return;
    this.saveCurrentDraft();
    this.currentIndex = index;
    this.optionIndex = 0;
    this.editingCustom = false;
    this.showingConfirmation = false;
    this.syncEditorForCurrentQuestion();
    this.refresh();
  }

  private saveCurrentDraft(): void {
    if (!this.isEditingText()) return;

    const question = this.currentQuestion();
    const value = this.editor.getText();
    this.drafts.set(question.id, value);

    if (question.options.length > 0) return;

    const trimmed = value.trim();
    if (!trimmed && question.required) {
      this.answers.delete(question.id);
      return;
    }

    this.answers.set(question.id, {
      id: question.id,
      value: trimmed,
      label: trimmed || "(blank)",
      kind: "text",
    });
  }

  private syncEditorForCurrentQuestion(): void {
    const question = this.currentQuestion();
    const existing = this.answers.get(question.id);
    this.editor.setText(this.drafts.get(question.id) ?? (existing?.kind !== "choice" ? existing?.value : undefined) ?? "");
  }

  private buildResult(cancelled: boolean): AskUserResult {
    if (!cancelled) this.saveCurrentTextAnswer();
    return {
      cancelled,
      questions: this.questions,
      answers: Array.from(this.answers.values()),
    };
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user one or more explicit questions and wait for their answers. Questions may include selectable options with descriptions and/or free-text answers.",
    promptSnippet: "Ask the user one or more clarifying questions with choices and/or free-text answers.",
    promptGuidelines: [
      "Use ask_user when progress is blocked by missing user input, ambiguous requirements, or a risky decision that should not be guessed.",
      "Do not use ask_user for questions that can be answered from repository context, existing instructions, or reasonable low-risk defaults.",
      "Batch related clarifying questions into one ask_user call instead of asking them one at a time.",
      "When using ask_user options, include concise descriptions when the tradeoffs are not obvious.",
    ],
    parameters: AskUserParams,
    prepareArguments: prepareAskUserArguments,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params.questions) as AskUserQuestion[];

      if (!ctx.hasUI) {
        const result: AskUserResult = { cancelled: true, questions, answers: [] };
        return {
          content: [{ type: "text", text: `Cannot ask the user because interactive UI is not available in this mode.\n\n${formatAskUserResult(result)}` }],
          details: result,
        };
      }

      const result = await ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
        return new AskUserComponent(params.title, questions, tui, theme, done);
      });

      return {
        content: [{ type: "text", text: formatAskUserResult(result) }],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const count = questions.length;
      const labels = questions.map((question: { label?: string; id?: string }, index: number) => question.label || question.id || `Q${index + 1}`);
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
      if (labels.length > 0) text += theme.fg("dim", ` (${truncateToWidth(labels.join(", "), 48)})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserResult | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      if (details.answers.length === 0) return new Text(theme.fg("warning", "No answers submitted"), 0, 0);

      const lines = details.answers.map((answer) => {
        const marker = answer.kind === "choice" && answer.optionIndex ? `${answer.optionIndex}. ` : "";
        const kind = answer.kind === "choice" ? "" : theme.fg("muted", ` (${answer.kind})`);
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${marker}${answer.label}${kind}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
