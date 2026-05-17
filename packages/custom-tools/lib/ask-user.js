/**
 * Normalize and format data for the ask_user Pi extension.
 * These helpers are kept outside the TUI component so behavior can be tested
 * without starting an interactive Pi session.
 */

/**
 * Normalize raw tool questions into the stable shape used by the UI and result details.
 *
 * @param {unknown[]} rawQuestions Questions provided by the model.
 * @returns {Array<{id:string,label:string,prompt:string,description?:string,options:Array<{value:string,label:string,description?:string}>,allowCustomAnswer:boolean,multiline:boolean,required:boolean}>}
 */
export function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("ask_user requires at least one question.");
  }

  return rawQuestions.map((raw, index) => normalizeQuestion(raw, index));
}

/**
 * Build the text sent back to the model after the user answers or cancels.
 *
 * @param {{cancelled:boolean,questions:Array<{id:string,label:string,prompt:string}>,answers:Array<{id:string,value:string,label:string,kind:string,optionIndex?:number}>}} result
 * @returns {string}
 */
export function formatAskUserResult(result) {
  if (result.cancelled) {
    return "User cancelled the questions. Do not assume answers; explain what remains blocked or ask again if the answers are still required.";
  }

  if (!Array.isArray(result.answers) || result.answers.length === 0) {
    return "User submitted no answers.";
  }

  const questionById = new Map((result.questions ?? []).map((question) => [question.id, question]));
  const lines = ["User answered the questions:"];

  for (const answer of result.answers) {
    const question = questionById.get(answer.id);
    const title = question?.label || answer.id;
    const prompt = question?.prompt;
    const prefix = answer.kind === "choice" && answer.optionIndex ? `selected ${answer.optionIndex}. ` : "";

    lines.push("");
    lines.push(`${title}: ${prompt ?? answer.id}`);
    lines.push(`Answer: ${prefix}${answer.label || answer.value}`);
    if (answer.kind === "custom") lines.push("Type: custom answer");
    if (answer.kind === "text") lines.push("Type: free-text answer");
  }

  return lines.join("\n");
}

/**
 * Whether a question has a usable answer. Optional blank answers are accepted.
 *
 * @param {{required:boolean}} question
 * @param {{value:string}|undefined} answer
 * @returns {boolean}
 */
export function isQuestionAnswered(question, answer) {
  if (!answer) return !question.required;
  if (!question.required) return true;
  return String(answer.value ?? "").trim().length > 0;
}

/**
 * Make the tool resilient to obvious singular-question calls while keeping the public schema strict.
 *
 * @param {unknown} args
 * @returns {unknown}
 */
export function prepareAskUserArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const input = /** @type {Record<string, unknown>} */ (args);
  if (Array.isArray(input.questions)) return args;

  const questionText = typeof input.question === "string" ? input.question : undefined;
  if (!questionText) return args;

  return {
    ...input,
    questions: [
      {
        id: typeof input.id === "string" ? input.id : "question",
        label: typeof input.label === "string" ? input.label : undefined,
        prompt: questionText,
        description: typeof input.description === "string" ? input.description : undefined,
        options: Array.isArray(input.options) ? input.options : undefined,
        allowCustomAnswer: typeof input.allowCustomAnswer === "boolean" ? input.allowCustomAnswer : undefined,
        multiline: typeof input.multiline === "boolean" ? input.multiline : undefined,
        required: typeof input.required === "boolean" ? input.required : undefined,
      },
    ],
  };
}

function normalizeQuestion(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Question ${index + 1} must be an object.`);
  }

  const input = /** @type {Record<string, unknown>} */ (raw);
  const prompt = cleanString(input.prompt);
  if (!prompt) throw new Error(`Question ${index + 1} is missing prompt.`);

  const id = cleanIdentifier(cleanString(input.id)) || `q${index + 1}`;
  const label = cleanString(input.label) || `Q${index + 1}`;
  const description = cleanString(input.description);
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const options = rawOptions.map((option, optionIndex) => normalizeOption(option, optionIndex)).filter(Boolean);

  return {
    id,
    label,
    prompt,
    ...(description ? { description } : {}),
    options,
    allowCustomAnswer: input.allowCustomAnswer !== false,
    multiline: input.multiline !== false,
    required: input.required !== false,
  };
}

function normalizeOption(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Option ${index + 1} must be an object.`);
  }

  const input = /** @type {Record<string, unknown>} */ (raw);
  const label = cleanString(input.label);
  if (!label) throw new Error(`Option ${index + 1} is missing label.`);

  const value = cleanString(input.value) || label;
  const description = cleanString(input.description);
  return {
    value,
    label,
    ...(description ? { description } : {}),
  };
}

function cleanString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanIdentifier(value) {
  if (!value) return undefined;
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || undefined;
}
