// Add-model family dropdown for the cloud-account providers: the family choice folds
// into the model id (`bedrock:claude/…`, `vertex:openweight/…`); plain providers keep
// the bare add-model row. Plus the Cherry Studio-style inline editors: per-row context
// window and display-name commits, and context-at-add-time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelChecklist } from "./ModelChecklist";

vi.mock("../api", () => ({
  addModel: vi.fn(async (id: string) => ({ ok: true, models: [id], model: id })),
  removeModel: vi.fn(async () => ({ ok: true, models: [], model: "" })),
  setDefaultModel: vi.fn(async () => ({ ok: true })),
  getSettings: vi.fn(async () => ({ models: [], model: "" })),
  setContextWindow: vi.fn(async () => ({ ok: true })),
  setModelLabel: vi.fn(async () => ({ ok: true })),
}));

import { addModel, setContextWindow, setModelLabel } from "../api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const KNOWN = ["openai", "anthropic", "bedrock", "vertex", "openrouter"];

function renderList(provider: string, props: Record<string, unknown> = {}) {
  return render(
    <ModelChecklist
      provider={provider}
      knownProviders={KNOWN}
      suggested={[]}
      curated={[]}
      defaultModel=""
      onChanged={() => {}}
      {...props}
    />,
  );
}

function addTyped(id: string) {
  fireEvent.change(screen.getByPlaceholderText("Add another model…"), {
    target: { value: id },
  });
  fireEvent.click(screen.getByText("Add"));
}

describe("ModelChecklist add-model family dropdown", () => {
  it("folds the selected vertex family into the id", async () => {
    renderList("vertex");
    fireEvent.change(screen.getByTestId("mlist-family"), {
      target: { value: "openweight" },
    });
    addTyped("meta/llama-4-maverick-17b-128e-instruct-maas");
    expect(addModel).toHaveBeenCalledWith(
      "vertex:openweight/meta/llama-4-maverick-17b-128e-instruct-maas",
    );
  });

  it("defaults bedrock to the Claude family and keeps a typed family verbatim", async () => {
    renderList("bedrock");
    addTyped("anthropic.claude-sonnet-4-6-v1:0");
    expect(addModel).toHaveBeenCalledWith(
      "bedrock:claude/anthropic.claude-sonnet-4-6-v1:0",
    );
    addTyped("other/amazon.nova-2-pro-v1:0");
    expect(addModel).toHaveBeenLastCalledWith("bedrock:other/amazon.nova-2-pro-v1:0");
  });

  it("shows no family dropdown for plain providers", async () => {
    renderList("openrouter");
    expect(screen.queryByTestId("mlist-family")).toBeNull();
    addTyped("z-ai/glm-5.2");
    expect(addModel).toHaveBeenCalledWith("openrouter:z-ai/glm-5.2");
  });
});

describe("ModelChecklist inline model config", () => {
  it("sets the context window when a row's token input blurs", async () => {
    renderList("deepseek", {
      suggested: ["deepseek-v4-flash"],
      contextWindows: { "deepseek:deepseek-v4-flash": 128000 },
    });
    const input = screen.getByTestId("mlist-ctx-deepseek:deepseek-v4-flash");
    expect(input).toHaveProperty("placeholder", "128000");
    fireEvent.change(input, { target: { value: "200000" } });
    fireEvent.blur(input);
    expect(setContextWindow).toHaveBeenCalledWith(
      "deepseek:deepseek-v4-flash",
      200000,
    );
  });

  it("sets the display name on blur; matching the built-in label clears it", async () => {
    renderList("deepseek", {
      suggested: ["deepseek-v4-flash"],
      labels: { "deepseek:deepseek-v4-flash": "DeepSeek V4 Flash · DeepSeek" },
    });
    const input = screen.getByTestId("mlist-name-deepseek:deepseek-v4-flash");
    expect(input).toHaveProperty("value", "DeepSeek V4 Flash · DeepSeek");
    fireEvent.change(input, { target: { value: "我的快模型" } });
    fireEvent.blur(input);
    expect(setModelLabel).toHaveBeenCalledWith("deepseek:deepseek-v4-flash", "我的快模型");
  });

  it("adds a custom model with its context window in one step", async () => {
    renderList("openai");
    fireEvent.change(screen.getByPlaceholderText("Add another model…"), {
      target: { value: "gpt-custom-1" },
    });
    fireEvent.change(screen.getByTestId("mlist-add-ctx"), {
      target: { value: "400000" },
    });
    fireEvent.click(screen.getByText("Add"));
    expect(addModel).toHaveBeenCalledWith("gpt-custom-1");
    await vi.waitFor(() =>
      expect(setContextWindow).toHaveBeenCalledWith("gpt-custom-1", 400000),
    );
  });
});
