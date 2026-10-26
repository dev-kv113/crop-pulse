/**
 * Rename and recolour a layer's categories.
 *
 * The API sends each analysis polygon its own colour, so saving here reaches
 * both the map and the legend on the farmer's next request -- the layer is not
 * reprocessed and the app is not rebuilt.
 *
 * The source class names (the raw density bands) are shown but never edited:
 * they are what the uploaded file said, and losing them would make it
 * impossible to check what a renamed category actually represents.
 */

import { useEffect, useState } from "react";

import { ApiError, api } from "../api";
import type { AdminLayer, LayerClass } from "../types";

interface LegendEditorProps {
  layer: AdminLayer;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function LegendEditor({ layer, onClose, onSaved }: LegendEditorProps) {
  const [classes, setClasses] = useState<LayerClass[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .adminLayerClasses(layer.id)
      .then(setClasses)
      .catch((err) => setError(err.message));
  }, [layer.id]);

  function update(classId: number, changes: Partial<LayerClass>) {
    setClasses((current) =>
      current?.map((c) => (c.class_id === classId ? { ...c, ...changes } : c)) ??
      null,
    );
  }

  function save() {
    if (!classes) return;
    setBusy(true);
    setError(null);
    api
      .adminSetLayerClasses(
        layer.id,
        classes.map(({ class_id, label, color }) => ({ class_id, label, color })),
      )
      .then(() => onSaved("Categories updated. Farmers see the change immediately."))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Could not save"),
      )
      .finally(() => setBusy(false));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit categories"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h3>Categories — {layer.name}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="hint">
          Name each category and pick its colour. Keeping the colours ordered
          light to dark preserves the sense of a scale; unrelated colours make it
          read as unrelated groups.
        </p>

        {error && <p className="error">{error}</p>}

        {!classes ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <div className="class-rows">
              {classes.map((cls) => (
                <div key={cls.class_id} className="class-row">
                  <input
                    type="color"
                    className="class-color"
                    value={cls.color}
                    onChange={(e) => update(cls.class_id, { color: e.target.value })}
                    aria-label={`Colour for ${cls.label}`}
                  />
                  <input
                    className="class-label"
                    value={cls.label}
                    onChange={(e) => update(cls.class_id, { label: e.target.value })}
                    aria-label={`Name for class ${cls.class_id}`}
                  />
                  <span className="class-source" title={cls.class_name}>
                    {cls.detail ?? cls.class_name}
                  </span>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button
                className="button button-quiet"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="button" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save categories"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
