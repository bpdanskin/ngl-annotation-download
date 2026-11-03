/* Neuroglancer annotation -> CSV, fully client-side.
 *
 * Pipeline per link:
 *   1. Parse the (possibly middleauth+ shortened) link into a state-JSON URL.
 *   2. Fetch the state JSON with an Authorization: Bearer <token> header.
 *   3. Walk annotation layers, flatten each annotation into a row.
 *   4. Concatenate rows across all links and write one CSV.
 *
 * Core functions are attached to window.App so they can be unit-tested from the
 * browser console against a fixture without needing a real token.
 */
(function () {
  "use strict";

  // ---- auth -----------------------------------------------------------------

  const TOKEN_KEY = "ngl_token";

  function getToken() {
    const fromField = (localStorage.getItem(TOKEN_KEY) || "").trim();
    if (fromField) return fromField;
    const cfg = window.NGL_CONFIG || {};
    return (cfg.token || "").trim();
  }

  // ---- link / state resolution ---------------------------------------------

  // Pull the state-JSON URL (or inline state) out of a neuroglancer link.
  // Handles:  https://viewer/#!middleauth+https://host/nglstate/api/v1/<id>
  //           https://viewer/#!https://host/nglstate/api/v1/<id>
  //           https://host/nglstate/api/v1/<id>            (raw state url)
  //           https://viewer/#!{ ...inline json... }       (inline state)
  function parseLink(rawLink) {
    const link = (rawLink || "").trim();
    if (!link) throw new Error("Empty link");

    let frag = link;
    const hash = link.indexOf("#");
    if (hash >= 0) frag = link.slice(hash + 1);
    if (frag.startsWith("!")) frag = frag.slice(1);
    if (frag.startsWith("middleauth+")) frag = frag.slice("middleauth+".length);

    if (frag.startsWith("http")) return { kind: "url", url: frag };
    if (frag.startsWith("%7B") || frag.startsWith("{")) {
      try {
        return { kind: "inline", state: JSON.parse(decodeURIComponent(frag)) };
      } catch (e) {
        throw new Error("Could not parse inline neuroglancer state: " + e.message);
      }
    }
    if (link.startsWith("http") && link.includes("/nglstate/")) {
      return { kind: "url", url: link };
    }
    throw new Error("Could not find a state URL in link");
  }

  // Short label for the "source" column: the trailing state id, else the url.
  function sourceLabel(parsed, rawLink) {
    if (parsed.kind === "url") {
      const m = parsed.url.match(/\/([0-9]+)(?:\/)?$/);
      if (m) return m[1];
      return parsed.url;
    }
    return (rawLink || "inline").slice(0, 60);
  }

  async function fetchState(url, token) {
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const resp = await fetch(url, { headers });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        "Unauthorized (" + resp.status + "). Check your auth token."
      );
    }
    if (!resp.ok) {
      throw new Error("Fetch failed: HTTP " + resp.status + " " + resp.statusText);
    }
    return resp.json();
  }

  // ---- coordinate space -----------------------------------------------------

  // state.dimensions looks like { x:[4e-9,"m"], y:[4e-9,"m"], z:[40e-9,"m"] }.
  // Returns nm-per-unit for the first three spatial axes, in axis order.
  function nmPerUnit(dimensions) {
    if (!dimensions || typeof dimensions !== "object") return null;
    const scales = [];
    for (const key of Object.keys(dimensions)) {
      const entry = dimensions[key];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const value = Number(entry[0]);
      const unit = String(entry[1] || "").toLowerCase();
      let nm;
      if (unit === "m") nm = value * 1e9;
      else if (unit === "mm") nm = value * 1e6;
      else if (unit === "um" || unit === "µm") nm = value * 1e3;
      else if (unit === "nm") nm = value;
      else if (unit === "") nm = value; // unitless -> assume already nm-ish
      else nm = null;
      scales.push(nm);
      if (scales.length === 3) break;
    }
    return scales.length ? scales : null;
  }

  function euclid(a, b) {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = Number(a[i]) - Number(b[i]);
      s += d * d;
    }
    return Math.sqrt(s);
  }

  function euclidNm(a, b, scales) {
    if (!scales) return null;
    let s = 0;
    const n = Math.min(a.length, b.length, scales.length);
    for (let i = 0; i < n; i++) {
      if (scales[i] == null) return null;
      const d = (Number(a[i]) - Number(b[i])) * scales[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  // ---- annotation geometry --------------------------------------------------

  // Return { a:[x,y,z], b:[x,y,z]|null, twoPoint:bool }.
  function geometry(ann) {
    const t = ann.type;
    if (t === "point" && ann.point) return { a: ann.point, b: null, twoPoint: false };
    if (ann.pointA && ann.pointB) return { a: ann.pointA, b: ann.pointB, twoPoint: true };
    if (t === "ellipsoid" && ann.center) return { a: ann.center, b: ann.radii || null, twoPoint: false };
    // Fallbacks for odd shapes.
    if (ann.point) return { a: ann.point, b: null, twoPoint: false };
    if (ann.pointA) return { a: ann.pointA, b: ann.pointB || null, twoPoint: !!ann.pointB };
    return { a: null, b: null, twoPoint: false };
  }

  function flattenSegments(segments) {
    if (!segments) return "";
    const out = [];
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x != null) out.push(String(x));
    };
    walk(segments);
    return out.join(" ");
  }

  // ---- state -> rows --------------------------------------------------------

  // Turn one resolved state into an array of flat row objects. `report` collects
  // human-readable notes (e.g. layers whose annotations live in a remote source
  // and so can't be read client-side).
  // "4 x 4 x 40" (nm/voxel) from the nm-per-unit scales, "" if unknown.
  function resolutionString(scales) {
    if (!scales || scales.some((s) => s == null)) return "";
    return scales.map((s) => round(s)).join(" x ");
  }

  function stateToRows(state, source, report) {
    const rows = [];
    const scales = nmPerUnit(state && state.dimensions);
    const resolution = resolutionString(scales);
    const layers = (state && state.layers) || [];

    for (const layer of layers) {
      if (!layer || layer.type !== "annotation") continue;
      const layerName = layer.name || "";
      const propDefs = layer.annotationProperties || [];

      // Inline annotations live on the layer (or, in some states, under source).
      let anns = layer.annotations;
      if (!anns && layer.source && typeof layer.source === "object") {
        anns = layer.source.annotations;
      }
      if (!Array.isArray(anns) || anns.length === 0) {
        if (report) {
          report.push(
            'Layer "' + layerName + '": no inline annotations' +
            (layer.source ? " (annotations are in a remote source and can't be read client-side)" : "")
          );
        }
        continue;
      }

      for (const ann of anns) {
        const g = geometry(ann);
        const row = {
          source: source,
          layer: layerName,
          annotation_id: ann.id != null ? String(ann.id) : "",
          type: ann.type || "",
          ax: g.a ? g.a[0] : "",
          ay: g.a ? g.a[1] : "",
          az: g.a ? g.a[2] : "",
          bx: g.b ? g.b[0] : "",
          by: g.b ? g.b[1] : "",
          bz: g.b ? g.b[2] : "",
          distance_native: "",
          distance_nm: "",
          resolution_nm_per_voxel: resolution,
          description: ann.description != null ? String(ann.description) : "",
          segments: flattenSegments(ann.segments),
        };

        if (g.twoPoint && g.a && g.b) {
          row.distance_native = round(euclid(g.a, g.b));
          const dnm = euclidNm(g.a, g.b, scales);
          if (dnm != null) row.distance_nm = round(dnm);
        }

        // Per-annotation property values, aligned to the layer's property defs.
        const propVals = ann.props || [];
        propDefs.forEach((pd, i) => {
          const name = "prop_" + (pd.description || pd.id || "p" + i);
          let v = propVals[i];
          // Resolve enum codes to their labels when the def provides a mapping.
          if (
            v != null &&
            Array.isArray(pd.enum_values) &&
            Array.isArray(pd.enum_labels)
          ) {
            const idx = pd.enum_values.indexOf(v);
            if (idx >= 0 && pd.enum_labels[idx] != null) v = pd.enum_labels[idx];
          }
          row[name] = v != null ? v : "";
        });

        rows.push(row);
      }
    }
    return rows;
  }

  function round(x) {
    return Math.round(x * 1000) / 1000;
  }

  // ---- CSV ------------------------------------------------------------------

  const FIXED_COLUMNS = [
    "source", "layer", "annotation_id", "type",
    "ax", "ay", "az", "bx", "by", "bz",
    "distance_native", "distance_nm", "resolution_nm_per_voxel",
    "description", "segments",
  ];

  function orderedColumns(rows) {
    const extras = [];
    const seen = new Set(FIXED_COLUMNS);
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          extras.push(k);
        }
      }
    }
    extras.sort();
    return FIXED_COLUMNS.concat(extras);
  }

  function csvEscape(value) {
    if (value == null) return "";
    const s = String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function rowsToCsv(rows) {
    const cols = orderedColumns(rows);
    const lines = [cols.map(csvEscape).join(",")];
    for (const row of rows) {
      lines.push(cols.map((c) => csvEscape(row[c])).join(","));
    }
    return lines.join("\r\n");
  }

  // ---- orchestration --------------------------------------------------------

  // Resolve + fetch + parse every link. Returns { rows, perLink, notes }.
  async function processLinks(links, token, onProgress) {
    const rows = [];
    const perLink = [];
    const notes = [];
    for (let i = 0; i < links.length; i++) {
      const raw = links[i];
      if (onProgress) onProgress(i, links.length, raw);
      try {
        const parsed = parseLink(raw);
        const label = sourceLabel(parsed, raw);
        const state =
          parsed.kind === "inline"
            ? parsed.state
            : await fetchState(parsed.url, token);
        const before = rows.length;
        const r = stateToRows(state, label, notes);
        rows.push(...r);
        perLink.push({ link: raw, label, ok: true, count: rows.length - before });
      } catch (e) {
        perLink.push({ link: raw, ok: false, error: e.message || String(e) });
      }
    }
    return { rows, perLink, notes };
  }

  function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "annotations.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.App = {
    TOKEN_KEY,
    getToken,
    parseLink,
    sourceLabel,
    fetchState,
    nmPerUnit,
    euclid,
    euclidNm,
    geometry,
    stateToRows,
    rowsToCsv,
    orderedColumns,
    processLinks,
    downloadCsv,
  };
})();
