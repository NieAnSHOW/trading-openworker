import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addModel,
  getSettings,
  removeModel,
  setContextWindow,
  setDefaultModel,
  setModelLabel,
  type ModelSettings,
} from "../api";

// Cloud-account providers dispatch by a family segment baked into the model id
// (`bedrock:claude/…`, `vertex:openweight/…`). The add-model row shows a dropdown so
// users pick the family instead of memorizing the prefix; curated matrix ids already
// carry theirs.
const MODEL_FAMILIES: Record<string, { value: string; label: string }[]> = {
  bedrock: [
    { value: "claude", label: "Claude" },
    { value: "other", label: "Other (Converse)" },
  ],
  vertex: [
    { value: "gemini", label: "Gemini" },
    { value: "claude", label: "Claude" },
    { value: "openweight", label: "Open weight" },
  ],
};

// One provider's models as a checklist (Cherry Studio-style rows): tick = shown in the
// composer's model picker, the black "default" badge marks the model new sessions use,
// and every row is a full model record — display name and context window (tokens) edit
// in place (empty context = follow the provider/matrix value). The free-type row below
// adds models by hand, context window included, so brand-new releases and gateway
// models work without an app update. Shared by Onboarding and Settings ▸ Models.
export function ModelChecklist({
  provider,
  knownProviders,
  suggested,
  curated,
  defaultModel,
  labels,
  contextWindows,
  contextOverrides,
  labelOverrides,
  onChanged,
}: {
  provider: string; // decides the id prefix; OpenAI models stay bare
  knownProviders: string[]; // all provider names, to parse prefixes in curated ids
  suggested: string[]; // bare model names suggested by the provider
  curated: string[]; // the full curated list (all providers, full ids)
  defaultModel: string;
  labels?: Record<string, string>; // display names (matrix ∪ overrides), full id → name
  // {full id → tokens}: effective windows (matrix ∪ overrides) — the grey placeholders.
  contextWindows?: Record<string, number>;
  // {full id → tokens}: only the user's overrides — the committed input values.
  contextOverrides?: Record<string, number>;
  // {full id → name}: only the user's display-name overrides.
  labelOverrides?: Record<string, string>;
  // Called with the full /v1/settings object after any server mutation (the refresh
  // path) or just {models, model} (tick). Consumers merge it into their settings state.
  onChanged: (next: { models: string[]; model: string } | ModelSettings) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [ctxDraft, setCtxDraft] = useState(""); // add-row context window (optional)
  const families = MODEL_FAMILIES[provider];
  const [family, setFamily] = useState(families?.[0]?.value || "");
  // In-progress edits live locally so typing never waits on a server round trip; a save
  // refreshes the parent, whose new props re-seed untouched rows.
  const [ctxEdits, setCtxEdits] = useState<Record<string, string>>({});
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});

  const provOf = (id: string) => {
    const i = id.indexOf(":");
    return i > 0 && knownProviders.includes(id.slice(0, i)) ? id.slice(0, i) : "openai";
  };
  const prefixed = (m: string) => (provider === "openai" || provOf(m) !== "openai" ? m : `${provider}:${m}`);
  const bare = (id: string) => (id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id);

  const rows = [
    ...suggested.map(prefixed),
    ...curated.filter((id) => provOf(id) === provider),
  ].filter((id, i, a) => a.indexOf(id) === i);

  const checked = (id: string) => curated.includes(id);
  const refresh = async () => {
    const s = await getSettings();
    // The full settings object, not just models/model: the parent's override maps
    // (context windows, labels) must refresh too, or inline edits go stale.
    onChanged(s);
  };

  const tick = async (id: string, on: boolean) => {
    const res = on ? await addModel(id) : await removeModel(id);
    if (res.ok) onChanged({ models: res.models, model: res.model });
  };
  const makeDefault = async (id: string) => {
    if (!checked(id)) await addModel(id); // defaulting an unticked row ticks it too
    await setDefaultModel(id);
    await refresh();
  };

  const commitName = async (id: string) => {
    const v = (nameEdits[id] ?? "").trim();
    const builtIn = labels?.[id] || bare(id);
    if (v === (labelOverrides?.[id] ?? builtIn)) return;
    // Naming it exactly like the built-in label just clears the override.
    const next = v === builtIn ? "" : v;
    const res = await setModelLabel(id, next).catch(() => ({ ok: false }));
    if (res.ok) {
      setNameEdits((s) => ({ ...s, [id]: next }));
      await refresh();
    }
  };

  const commitContext = async (id: string) => {
    const raw = (ctxEdits[id] ?? "").trim();
    if (!raw) {
      // Empty input = follow the built-in value → clear any override.
      if (contextOverrides?.[id] != null) {
        await setContextWindow(id, null).catch(() => {});
        await refresh();
      }
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    const res = await setContextWindow(id, Math.round(n)).catch(() => ({ ok: false }));
    if (res.ok) await refresh();
  };

  const add = async () => {
    let typed = draft.trim();
    if (!typed) return;
    // Fold the family choice into the id unless the user already typed one.
    if (families && !families.some((f) => typed.startsWith(`${f.value}/`))) {
      typed = `${family}/${typed}`;
    }
    const full = prefixed(typed);
    const res = await addModel(full);
    if (res.ok) {
      setDraft("");
      // Context set at creation time (optional) — same per-model store as the rows.
      const n = Number(ctxDraft.trim());
      if (ctxDraft.trim() && Number.isFinite(n) && n > 0) {
        await setContextWindow(full, Math.round(n)).catch(() => {});
      }
      setCtxDraft("");
      await refresh();
    }
  };

  const ctxInput =
    "w-[88px] shrink-0 px-1.5 py-1 rounded-md border border-line bg-paper text-[12px] text-ink text-right tabular-nums outline-none focus:border-accent";

  return (
    <div className="mlist">
      {rows.map((id) => {
        const isDefault = id === defaultModel;
        const overridden = contextOverrides?.[id] != null;
        return (
          <div className={"mlist-row" + (checked(id) ? "" : " off")} key={id}>
            <label className="mlist-main">
              <input
                type="checkbox"
                checked={checked(id)}
                disabled={isDefault}
                title={isDefault ? t("models.default_locked") : undefined}
                onChange={(e) => tick(id, e.target.checked)}
              />
              <input
                className="mlist-name bg-transparent border-0 p-0 outline-none focus:underline focus:decoration-line min-w-0 flex-1 cursor-text"
                value={
                  nameEdits[id] !== undefined
                    ? nameEdits[id]
                    : labelOverrides?.[id] ?? labels?.[id] ?? bare(id)
                }
                title={id}
                spellCheck={false}
                data-testid={`mlist-name-${id}`}
                onChange={(e) => setNameEdits((s) => ({ ...s, [id]: e.target.value }))}
                onBlur={() => void commitName(id)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </label>
            <input
              type="number"
              className={ctxInput}
              placeholder={String(contextWindows?.[id] || 128000)}
              title={t("models.ctx_title")}
              value={
                ctxEdits[id] !== undefined
                  ? ctxEdits[id]
                  : overridden
                    ? String(contextOverrides?.[id])
                    : ""
              }
              data-testid={`mlist-ctx-${id}`}
              onChange={(e) => setCtxEdits((s) => ({ ...s, [id]: e.target.value }))}
              onBlur={() => void commitContext(id)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            {isDefault ? (
              <span className="mlist-default">{t("models.default_badge")}</span>
            ) : (
              <button className="mlist-make" onClick={() => makeDefault(id)}>
                {t("models.make_default")}
              </button>
            )}
          </div>
        );
      })}
      <div className="mlist-add">
        {families && (
          <select
            value={family}
            onChange={(e) => setFamily(e.target.value)}
            aria-label="Model family"
            data-testid="mlist-family"
          >
            {families.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        <input
          placeholder={t("models.add_placeholder")}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <input
          type="number"
          className={ctxInput}
          placeholder={t("models.add_ctx_placeholder")}
          title={t("models.ctx_title")}
          value={ctxDraft}
          data-testid="mlist-add-ctx"
          onChange={(e) => setCtxDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn-primary sm" onClick={add} disabled={!draft.trim()}>
          {t("models.add_btn")}
        </button>
      </div>
    </div>
  );
}
