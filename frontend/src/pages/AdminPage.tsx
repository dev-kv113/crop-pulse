/**
 * Admin screen.
 *
 * Organised around units, because that is how the data arrives: one plot
 * register per unit, then one analysis GeoJSON per unit per survey date. A unit
 * is chosen once at the top and everything below is scoped to it, so there is
 * never a doubt about which unit an upload will land in.
 *
 * Uploading an analysis layer starts a background job on the server, so the
 * layer table polls until it reports 'ready' or 'failed'.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { AppHeader } from "../components/AppHeader";
import { FarmerTable } from "../components/FarmerTable";
import { LegendEditor } from "../components/LegendEditor";
import type { AdminLayer, AdminPlot, AdminStats, Unit } from "../types";

export function AdminPage() {
  const { signOut } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [layers, setLayers] = useState<AdminLayer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextStats, nextUnits] = await Promise.all([
      api.adminStats(),
      api.adminUnits(),
    ]);
    setStats(nextStats);
    setUnits(nextUnits);
    // Open on a unit that actually holds data, so the screen is not blank.
    setUnitId(
      (current) =>
        current ??
        nextUnits.find((u) => u.plot_count > 0)?.id ??
        nextUnits[0]?.id ??
        null,
    );
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, [refresh]);

  const loadLayers = useCallback(async () => {
    if (unitId === null) return;
    setLayers(await api.adminLayers(unitId));
  }, [unitId]);

  useEffect(() => {
    void loadLayers().catch((err) => setError(err.message));
  }, [loadLayers]);

  // Keep polling while any layer in this unit is still being processed.
  const processing = layers.some(
    (layer) => layer.status === "pending" || layer.status === "processing",
  );
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => {
      void loadLayers().catch(() => {});
      void refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [processing, loadLayers, refresh]);

  function report(action: Promise<unknown>, success: string) {
    setError(null);
    setMessage(null);
    action
      .then(() => {
        setMessage(success);
        return Promise.all([refresh(), loadLayers()]);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Something went wrong"),
      );
  }

  const unit = units.find((u) => u.id === unitId) ?? null;

  return (
    <main className="admin">
      <AppHeader
        title="Administration"
        subtitle={
          unit
            ? `${unit.name} · ${unit.plot_count.toLocaleString("en-IN")} plots`
            : undefined
        }
        actions={
          <button className="button button-quiet button-small" onClick={signOut}>
            Sign out
          </button>
        }
      />

      <div className="admin-body">
        {stats && (
          <section className="stat-row card-wide">
            <Stat label="Units" value={stats.units} />
            <Stat label="Farmers" value={stats.farmers} />
            <Stat label="With a login" value={stats.farmers_with_phone} />
            <Stat label="Plots" value={stats.plots} />
            <Stat label="Published layers" value={stats.published_layers} />
          </section>
        )}

        {message && <p className="success card-wide">{message}</p>}
        {error && <p className="error card-wide">{error}</p>}

        <UnitPicker
          units={units}
          unitId={unitId}
          onSelect={setUnitId}
          onDone={report}
        />

        {/*
          Order is the work in the order it is done, and the grid pairs the
          narrow cards two to a row on a wide screen:

            get data in     Plot register   |  Survey upload
            say who sees it Unit heads      |  Read-only admins
            check it        Survey dates       (full width, has a table)
            use it          Farmers            (full width, has a table)

          The two access cards are the same component and the same size, so they
          pair the way the two uploads do. `ViewerCard` sits between the halves
          of the unit block rather than inside it because it is mill-wide, not
          this unit's — its position in the grid is the only thing it takes from
          the unit beside it.
        */}
        {unit && (
          <>
            <PlotRegisterCard unit={unit} onDone={report} />
            <AnalysisUploadCard unit={unit} onDone={report} />
            <UnitHeadCard key={unit.id} unit={unit} onDone={report} />
          </>
        )}

        <ViewerCard onDone={report} />

        {unit && (
          <>
            <LayerTable unit={unit} layers={layers} onDone={report} />
            <FarmerPreviewCard unit={unit} onDone={report} />
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value.toLocaleString("en-IN")}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

type Reporter = (action: Promise<unknown>, success: string) => void;

// -------------------------------------------------------- read-only admins ---

/**
 * Who may see every unit without being able to change any of it.
 *
 * Not scoped to a unit, unlike a unit head, so it takes no `unit` prop and
 * survives a change of unit untouched. It sits beside the unit-heads card
 * because the two answer the same question — who can sign in, and to what.
 */
function ViewerCard({ onDone }: { onDone: Reporter }) {
  const load = useCallback(() => api.adminViewers(), []);
  const add = useCallback(
    (phone: string, name?: string) => api.adminAddViewer(phone, name),
    [],
  );
  const remove = useCallback(
    (person: Person) => api.adminRemoveViewer(person.id),
    [],
  );

  return (
    <PeopleCard
      title="Read-only admins"
      hint="These numbers sign in to a screen showing every unit — its farmers, any farmer's plot exactly as that farmer sees it, and its crop monitoring dashboard. They cannot upload, rename, publish, or grant a login."
      addLabel="Grant read-only access"
      emptyHint="Nobody has this access yet."
      load={load}
      add={add}
      remove={remove}
      onDone={onDone}
    />
  );
}

// ------------------------------------------------------------------ units ---

function UnitPicker({
  units,
  unitId,
  onSelect,
  onDone,
}: {
  units: Unit[];
  unitId: number | null;
  onSelect: (id: number) => void;
  onDone: Reporter;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const unit = units.find((u) => u.id === unitId) ?? null;

  // Editing follows the selection: switching units mid-edit must not carry the
  // previous unit's code across into the field.
  useEffect(() => {
    setCode(unit?.analytics_code ?? "");
  }, [unit?.id, unit?.analytics_code]);

  return (
    <section className="card card-wide">
      <h2>Unit</h2>
      <p className="hint">
        Everything below applies to the selected unit. Data arrives one unit at a
        time, so uploads, survey dates and category colours are all scoped to it.
      </p>

      <div className="unit-grid">
        {units.map((u) => (
          <button
            key={u.id}
            className={`unit-chip ${u.id === unitId ? "is-on" : ""}`}
            onClick={() => onSelect(u.id)}
          >
            <span className="unit-chip-name">{u.name}</span>
            <span className="unit-chip-meta">
              {u.plot_count.toLocaleString("en-IN")} plots · {u.layer_count}{" "}
              {u.layer_count === 1 ? "date" : "dates"}
            </span>
            <span className="unit-chip-meta">
              {u.head_count === 0
                ? "no head"
                : `${u.head_count} ${u.head_count === 1 ? "head" : "heads"}`}
            </span>
            {/* Which mill each unit points at, visible across all eight at
                once. Without it, finding who holds a code means opening every
                unit in turn. */}
            <span className="unit-chip-meta">
              {u.analytics_code
                ? `${u.analytics_code} dashboard`
                : "no dashboard"}
            </span>
          </button>
        ))}
      </div>

      {unit &&
        (renaming ? (
          <form
            className="inline-form unit-rename"
            onSubmit={(event) => {
              event.preventDefault();
              onDone(api.adminRenameUnit(unit.id, name), "Unit renamed.");
              setRenaming(false);
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Naharpur"
              autoFocus
            />
            <button
              className="button button-small"
              type="submit"
              disabled={!name.trim()}
            >
              Save
            </button>
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={() => setRenaming(false)}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            className="button button-quiet button-small unit-rename"
            onClick={() => {
              setName(unit.name);
              setRenaming(true);
            }}
          >
            Rename {unit.name}
          </button>
        ))}

      {unit && (
        <form
          className="inline-form unit-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const next = code.trim().toUpperCase();
            // A code only ever belongs to one unit, so setting it here takes it
            // off whoever held it. Say so: that unit's head loses their
            // dashboard, and finding that out later is no way to hear it.
            const displaced = units.find(
              (u) => u.id !== unit.id && u.analytics_code === next,
            );
            onDone(
              api.adminSetUnitAnalytics(unit.id, next),
              !next
                ? `${unit.name} no longer shows a dashboard.`
                : displaced
                  ? `${unit.name} now shows the ${next} dashboard. ${displaced.name} no longer has one.`
                  : `${unit.name} now shows the ${next} dashboard.`,
            );
          }}
        >
          <label className="hint" htmlFor="analytics-code">
            Monitoring dashboard code
          </label>
          <input
            id="analytics-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. DEO"
            maxLength={16}
            /* Same shape the dashboard accepts in its URL, so a code it would
               reject cannot be saved here. */
            pattern="[A-Za-z0-9_-]{1,16}"
          />
          <button
            className="button button-small"
            type="submit"
            disabled={code.trim().toUpperCase() === (unit.analytics_code ?? "")}
          >
            Save
          </button>
        </form>
      )}

      {unit && (
        <p className="hint">
          This decides which mill the unit head sees on their crop monitoring
          card. It is separate from the name above, so renaming a unit never
          breaks its dashboard. Clear the box to remove the dashboard. A code
          already held by another unit moves here — one unit, one mill.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------- plot register ---

function PlotRegisterCard({ unit, onDone }: { unit: Unit; onDone: Reporter }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section className="card">
      <h2>Plot register — {unit.name}</h2>
      <p className="hint">
        The GeoJSON of plot boundaries and farmer details for this unit.
        Uploading again updates existing plots rather than duplicating them.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const file = input.current?.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.append("file", file);
          form.append("unit_id", String(unit.id));
          setBusy(true);
          onDone(
            api.adminImportPlots(form).finally(() => setBusy(false)),
            `Plot register imported into ${unit.name}.`,
          );
        }}
      >
        <input ref={input} type="file" accept=".geojson,.json" required />
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Importing…" : `Import plots into ${unit.name}`}
        </button>
      </form>
    </section>
  );
}

// --------------------------------------------------------- analysis upload --

function AnalysisUploadCard({ unit, onDone }: { unit: Unit; onDone: Reporter }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("Crop Status");
  const [captureDate, setCaptureDate] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <section className="card">
      <h2>Add a survey date — {unit.name}</h2>
      <p className="hint">
        One GeoJSON per survey date. Upload the next file — 10 August, say —
        and it becomes another date farmers can switch to; existing dates are
        untouched. A large file takes a few minutes to upload and process, and
        the table below shows progress.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const file = input.current?.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.append("file", file);
          form.append("unit_id", String(unit.id));
          form.append("name", name);
          form.append("capture_date", captureDate);
          if (description) form.append("description", description);
          setBusy(true);
          onDone(
            api.adminUploadLayer(form).finally(() => setBusy(false)),
            "Upload accepted. Processing has started.",
          );
        }}
      >
        <label className="field">
          <span>Survey date</span>
          <input
            type="date"
            value={captureDate}
            onChange={(event) => setCaptureDate(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Layer name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <input ref={input} type="file" accept=".geojson,.json" required />
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload survey layer"}
        </button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ layers --

function LayerTable({
  unit,
  layers,
  onDone,
}: {
  unit: Unit;
  layers: AdminLayer[];
  onDone: Reporter;
}) {
  const [editing, setEditing] = useState<AdminLayer | null>(null);

  return (
    <section className="card card-wide">
      <h2>Survey dates — {unit.name}</h2>
      {layers.length === 0 ? (
        <p className="hint">No survey layers uploaded for this unit yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Name</th>
                <th>Status</th>
                <th className="num">Source</th>
                <th className="num">Clipped</th>
                <th>Visible</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {layers.map((layer) => (
                <tr key={layer.id}>
                  <td data-label="Date">{formatDate(layer.capture_date)}</td>
                  <td data-label="Name">{layer.name}</td>
                  <td data-label="Status">
                    <span className={`badge badge-${layer.status}`}>
                      {layer.status}
                    </span>
                    {layer.error && (
                      <div className="error-small">{layer.error}</div>
                    )}
                  </td>
                  <td className="num" data-label="Source">
                    {layer.feature_count.toLocaleString("en-IN")}
                  </td>
                  <td className="num" data-label="Clipped">
                    {layer.clipped_count.toLocaleString("en-IN")}
                  </td>
                  <td data-label="Visible">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={layer.is_published}
                        onChange={(event) =>
                          onDone(
                            api.adminUpdateLayer(layer.id, {
                              is_published: event.target.checked,
                            }),
                            event.target.checked
                              ? "Layer is now visible to farmers."
                              : "Layer hidden from farmers.",
                          )
                        }
                      />
                      <span>{layer.is_published ? "Yes" : "No"}</span>
                    </label>
                  </td>
                  <td className="row-actions" data-label="">
                    <button
                      className="button button-quiet button-small"
                      disabled={layer.status !== "ready"}
                      onClick={() => setEditing(layer)}
                    >
                      Categories
                    </button>
                    <button
                      className="button button-quiet button-small button-danger"
                      onClick={() => {
                        if (
                          !confirm(
                            `Delete the ${formatDate(layer.capture_date)} layer and its analysis? This cannot be undone.`,
                          )
                        )
                          return;
                        onDone(api.adminDeleteLayer(layer.id), "Layer deleted.");
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <LegendEditor
          layer={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            onDone(Promise.resolve(), message);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------- preview ---

/**
 * Find a farmer and open their screen, with the phone number editable in place.
 *
 * The table itself is shared with the unit-head screen, so both roles search and
 * page identically; only the editable phone column differs.
 */
function FarmerPreviewCard({ unit, onDone }: { unit: Unit; onDone: Reporter }) {
  const fetchPage = useCallback(
    (search: string, offset: number, limit: number) =>
      api.adminPlots(search, unit.id, offset, limit),
    [unit.id],
  );

  return (
    <section className="card card-wide">
      <h2>Farmers — {unit.name}</h2>
      <p className="hint">
        Set a farmer's login number and open their plot exactly as they see it. A
        farmer cannot sign in until their number is on file.
      </p>
      <FarmerTable
        // Remounting on a unit change resets the search and paging, which is
        // what you want: results from the previous unit are not relevant.
        key={unit.id}
        fetchPage={fetchPage}
        emptyHint={`No plots matched that search in ${unit.name}.`}
        renderPhone={(plot: AdminPlot) => (
          <PhoneEditor
            key={`${plot.farm_code}-${plot.phone ?? ""}`}
            farmCode={plot.farm_code}
            phone={plot.phone}
            onDone={onDone}
          />
        )}
      />
    </section>
  );
}

// ----------------------------------------------------- people who sign in ---

interface Person {
  id: number;
  phone: string;
  name: string | null;
}

/**
 * A list of people who may sign in, with a form to add and a button to remove.
 *
 * Unit heads and read-only admins are the same interaction over a different
 * list, so they are the same component: add a number, see who has access,
 * take it away. Writing it twice would be two places for the confirm text, the
 * refresh-after-change and the empty state to drift apart.
 */
function PeopleCard({
  title,
  hint,
  addLabel,
  emptyHint,
  load,
  add,
  remove,
  onDone,
}: {
  title: string;
  hint: ReactNode;
  addLabel: string;
  emptyHint: string;
  /** Must be stable, or the list refetches on every render. */
  load: () => Promise<Person[]>;
  add: (phone: string, name?: string) => Promise<unknown>;
  remove: (person: Person) => Promise<unknown>;
  onDone: Reporter;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");

  const refresh = useCallback(() => {
    load()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [load]);

  useEffect(refresh, [refresh]);

  // Every change has to show up in the list, and `onDone` already owns the
  // message and the error, so the refresh rides on the same promise.
  const done = (action: Promise<unknown>, success: string) =>
    onDone(
      action.then((result) => {
        refresh();
        return result;
      }),
      success,
    );

  return (
    /* Narrow, so it pairs with its twin on a wide screen. Grid items stretch,
       which is what keeps the two the same height however many rows each has. */
    <section className="card">
      <h2>{title}</h2>
      <p className="hint">{hint}</p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          done(add(phone, name || undefined), `${name || phone} can now sign in.`);
          setPhone("");
          setName("");
        }}
      >
        <label className="field">
          <span>Mobile number</span>
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            placeholder="98765 43210"
            onChange={(event) => setPhone(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="button" type="submit" disabled={!phone.trim()}>
          {addLabel}
        </button>
      </form>

      {people.length === 0 ? (
        <p className="hint">{emptyHint}</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Mobile</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <td data-label="Name">{person.name ?? "—"}</td>
                  <td data-label="Mobile">{person.phone}</td>
                  <td className="row-actions" data-label="">
                    <button
                      className="button button-quiet button-small button-danger"
                      onClick={() => {
                        const who = person.name ?? person.phone;
                        if (!confirm(`Remove access for ${who}?`)) return;
                        done(remove(person), `${who} can no longer sign in.`);
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Who can sign in to oversee this unit. A unit may have several. */
function UnitHeadCard({ unit, onDone }: { unit: Unit; onDone: Reporter }) {
  const load = useCallback(() => api.adminUnitHeads(unit.id), [unit.id]);
  const add = useCallback(
    (phone: string, name?: string) => api.adminAddUnitHead(unit.id, phone, name),
    [unit.id],
  );
  const remove = useCallback(
    (person: Person) => api.adminRemoveUnitHead(unit.id, person.id),
    [unit.id],
  );

  return (
    <PeopleCard
      title={`Unit heads — ${unit.name}`}
      hint={`These numbers sign in to see every farmer in ${unit.name} and open their screens. They cannot upload data or reach another unit. Add as many as the unit needs.`}
      addLabel="Add unit head"
      emptyHint={`Nobody oversees ${unit.name} yet.`}
      load={load}
      add={add}
      remove={remove}
      onDone={onDone}
    />
  );
}

// ---------------------------------------------------------- phone editing ---

/**
 * Sets the number a farmer signs in with, from inside the farmer table.
 *
 * Looks the farmer up by farm code, so the caller does not need a farmer id -
 * the plot rows already carry the code.
 */
function PhoneEditor({
  farmCode,
  phone,
  onDone,
}: {
  farmCode: string | null;
  phone: string | null;
  onDone: Reporter;
}) {
  const [value, setValue] = useState(phone ?? "");
  const dirty = value.trim() !== (phone ?? "");

  if (!farmCode) return <span className="cell-warn">—</span>;

  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        onDone(
          api
            .adminFarmers(farmCode)
            .then((matches) => {
              const farmer = matches.find((f) => f.farm_code === farmCode);
              if (!farmer) throw new ApiError("Farmer not found", 404);
              return api.adminSetFarmerPhone(farmer.id, value);
            }),
          `Login number saved for ${farmCode}.`,
        );
      }}
    >
      <input
        type="tel"
        inputMode="numeric"
        value={value}
        placeholder="98765 43210"
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        className="button button-small"
        type="submit"
        disabled={!value.trim() || !dirty}
      >
        Save
      </button>
    </form>
  );
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
