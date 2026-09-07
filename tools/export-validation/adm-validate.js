/**
 * Independent ADM (ITU-R BS.2076) structural validator.
 *
 * ── What this is, precisely ──────────────────────────────────────────────────────────
 * ITU-R BS.2076 publishes normative XSD schemas, but the ITU does not license them for
 * redistribution, so this repository cannot vendor one and CI cannot download one. What
 * this module does instead is a **structural and referential validation** derived from
 * the published specification text: element nesting, required attributes, ID grammar,
 * cross-reference resolution, DirectSpeakers semantics and coordinate consistency.
 *
 * Terminology used honestly throughout this project:
 *
 *   "well-formed"            the XML parses — proven here and by any XML parser
 *   "structurally validated" nesting/attributes/IDs/cross-references check out —
 *                            proven here
 *   "schema validated"       validated against the normative BS.2076 XSD —
 *                            NOT proven here; run `npm run validate:adm -- --xsd <path>`
 *                            with your own licensed copy of the schema
 *   "Dolby Atmos certified"  NOT true, never claimed, and not achievable with this
 *                            toolchain — see docs/EXPORT-INTEROPERABILITY.md
 *
 * The XML parser below is a small, dependency-free, non-validating parser. It exists so
 * this module works in Node and in a browser without pulling in a DOM.
 */

/** BS.2076 typeDefinition ⇄ typeLabel pairs. */
export const ADM_TYPE_LABELS = Object.freeze({
  '0001': 'DirectSpeakers',
  '0002': 'Matrix',
  '0003': 'Objects',
  '0004': 'HOA',
  '0005': 'Binaural',
});

/**
 * BS.2076 ID grammars.
 *
 * BS.2076 §5.2 also requires the four type digits embedded in an `AC_`/`AP_` identifier to
 * equal the element's `typeLabel`. Writing this validator surfaced a genuine defect in
 * Signal Rot's own writer: it emitted `typeLabel="0003"` (Objects) alongside
 * `typeDefinition="DirectSpeakers"` and `AC_0003…` IDs. That is fixed in
 * `src/audio/immersive/adm.js`; the check that caught it stays here.
 */
export const ID_PATTERNS = Object.freeze({
  audioProgrammeID: /^APR_[0-9A-Fa-f]{4}$/,
  audioContentID: /^ACO_[0-9A-Fa-f]{4}$/,
  audioObjectID: /^AO_[0-9A-Fa-f]{4}$/,
  audioPackFormatID: /^AP_[0-9A-Fa-f]{8}$/,
  audioChannelFormatID: /^AC_[0-9A-Fa-f]{8}$/,
  audioBlockFormatID: /^AB_[0-9A-Fa-f]{8}_[0-9A-Fa-f]{8}$/,
  audioStreamFormatID: /^AS_[0-9A-Fa-f]{8}$/,
  audioTrackFormatID: /^AT_[0-9A-Fa-f]{8}_[0-9A-Fa-f]{2}$/,
  audioTrackUID: /^ATU_[0-9A-Fa-f]{8}$/,
});

/** `hh:mm:ss.nnnnnnnnn` (BS.2076 timecode) or the older `hh:mm:ss.sssss`. */
const TIMECODE = /^\d{2}:\d{2}:\d{2}\.\d{1,9}$/;

/** BS.2051 loudspeaker label grammar: layer letter, sign, three-digit azimuth. */
const BS2051_LABEL = /^[MUBT][+-]\d{3}$/;

/**
 * Vendor-namespaced custom label. BS.2076 permits custom speaker labels; the convention
 * this project follows (and the one the Sonic Lab 20.4 layout needs, because no ITU label
 * describes a surveyed venue position) is an upper-case vendor prefix followed by `_`.
 * A label without a namespace is the dangerous case — it can silently collide with a
 * future ITU label — so that still warns.
 */
const CUSTOM_LABEL = /^[A-Z][A-Z0-9]{2,}_[A-Z0-9_]+$/;

/**
 * Does this speaker label denote a low-frequency channel?
 *
 * BS.2051 uses `LFE1`/`LFE2`. A venue rig with several discrete, separately-positioned
 * subwoofers has no ITU label for them at all, so vendor-namespaced labels containing
 * `SUB` are recognised as well — otherwise every Sonic Lab subwoofer would be reported as
 * a non-LFE channel that mysteriously carries a low-pass frequency element.
 */
const isLowFrequencyLabel = (label) => /^LFE/.test(label) || /(^|_)(LFE|SUB)(_|\d*$)/.test(label);

// ────────────────────────────────────────────────────────────────────────────────────
// Minimal XML parser
// ────────────────────────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s) {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/**
 * @typedef {object} XmlNode
 * @property {string} name           local name
 * @property {string|null} prefix
 * @property {Record<string,string>} attrs
 * @property {XmlNode[]} children
 * @property {string} text
 * @property {XmlNode|null} parent
 */

/**
 * Parse XML into a node tree. Throws `SyntaxError` on anything not well-formed.
 * @param {string} xml
 * @returns {{root: XmlNode, declaration: {version?: string, encoding?: string}|null}}
 */
export function parseXml(xml) {
  if (typeof xml !== 'string') throw new SyntaxError('parseXml: input is not a string');
  let i = 0;
  let declaration = null;

  const decl = /^\s*<\?xml\s+([^?]*)\?>/.exec(xml);
  if (decl) {
    declaration = {};
    for (const m of decl[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) declaration[m[1]] = m[2];
    i = decl[0].length;
  }

  /** @type {XmlNode|null} */
  let root = null;
  /** @type {XmlNode[]} */
  const stack = [];

  const splitName = (q) => {
    const c = q.indexOf(':');
    return c < 0 ? { prefix: null, name: q } : { prefix: q.slice(0, c), name: q.slice(c + 1) };
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (xml.slice(i).trim() && stack.length) {
        throw new SyntaxError('Character data after the document element');
      }
      break;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (stack.length) stack[stack.length - 1].text += unescapeXml(text);
      else if (text.trim()) throw new SyntaxError('Character data outside the document element');
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end < 0) throw new SyntaxError('Unterminated comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end < 0) throw new SyntaxError('Unterminated CDATA section');
      if (stack.length) stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw new SyntaxError('Unterminated processing instruction or declaration');
      i = end + 1;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw new SyntaxError('Unterminated closing tag');
      const q = xml.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top) throw new SyntaxError(`Closing tag </${q}> with no open element`);
      const expected = top.prefix ? `${top.prefix}:${top.name}` : top.name;
      if (q !== expected) {
        throw new SyntaxError(`Mismatched tags: <${expected}> closed by </${q}>`);
      }
      i = end + 1;
      continue;
    }

    // Opening / self-closing tag.
    let end = lt + 1;
    let inQuote = null;
    while (end < xml.length) {
      const c = xml[end];
      if (inQuote) {
        if (c === inQuote) inQuote = null;
      } else if (c === '"' || c === "'") inQuote = c;
      else if (c === '>') break;
      end++;
    }
    if (end >= xml.length) throw new SyntaxError('Unterminated tag');
    let body = xml.slice(lt + 1, end);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new SyntaxError(`Malformed tag at offset ${lt}`);
    const { prefix, name } = splitName(nameMatch[1]);
    const attrs = {};
    const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am;
    const rest = body.slice(nameMatch[1].length);
    // Track what the attribute matcher consumed. Anything left over that is not
    // whitespace is a malformed attribute — checking the *residue* rather than the whole
    // tag matters, because an escaped `&quot;` inside a legitimate quoted value would
    // otherwise look like an unquoted one.
    let consumedTo = 0;
    let residue = '';
    while ((am = attrRe.exec(rest))) {
      const key = am[1];
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        throw new SyntaxError(`Duplicate attribute "${key}" on <${name}>`);
      }
      attrs[key] = unescapeXml(am[3] ?? am[4] ?? '');
      residue += rest.slice(consumedTo, am.index);
      consumedTo = am.index + am[0].length;
    }
    residue += rest.slice(consumedTo);
    if (residue.trim()) {
      throw new SyntaxError(
        `Malformed attribute on <${name}>: ${JSON.stringify(residue.trim())} ` +
          '(an attribute value must be quoted).',
      );
    }

    const node = {
      name,
      prefix,
      attrs,
      children: [],
      text: '',
      parent: stack[stack.length - 1] ?? null,
    };
    if (node.parent) node.parent.children.push(node);
    else if (root) throw new SyntaxError('More than one document element');
    else root = node;
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }

  if (stack.length) throw new SyntaxError(`Unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) throw new SyntaxError('No document element');
  return { root, declaration };
}

/** Depth-first search for every descendant with a given local name. */
export function findAll(node, name, out = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** First descendant with a given local name, or null. */
export function findOne(node, name) {
  return findAll(node, name)[0] ?? null;
}

/** Resolve the in-scope default namespace for a node. */
function defaultNamespaceOf(node) {
  for (let n = node; n; n = n.parent) {
    if (n.attrs.xmlns) return n.attrs.xmlns;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * Structurally validate an ADM XML document.
 *
 * @param {string} xml
 * @param {object} [opts]
 * @param {number} [opts.expectedChannels]  cross-check against the WAV channel count
 * @param {string[]} [opts.expectedTrackUids] cross-check against the chna chunk
 * @param {number} [opts.sampleRate]
 * @param {number} [opts.bitDepth]
 * @returns {{valid: boolean, wellFormed: boolean, errors: string[], warnings: string[], summary: object}}
 */
export function validateAdmXml(xml, opts = {}) {
  const errors = [];
  const warnings = [];
  /** @type {any} */
  const summary = {
    wellFormed: false,
    rootElement: null,
    defaultNamespace: null,
    admVersion: null,
    counts: {},
    typeDefinitions: [],
    speakerLabels: [],
    schemaValidated: false,
    schemaValidationNote:
      'Structural validation only. The normative ITU-R BS.2076 XSD is not redistributable; ' +
      'run `npm run validate:adm -- --xsd <path>` with a licensed copy for schema validation.',
  };

  let tree;
  try {
    tree = parseXml(xml);
  } catch (e) {
    errors.push(`XML is not well-formed: ${e.message}`);
    return { valid: false, wellFormed: false, errors, warnings, summary };
  }
  summary.wellFormed = true;
  const root = tree.root;
  summary.rootElement = root.name;
  summary.defaultNamespace = defaultNamespaceOf(root);

  if (tree.declaration && tree.declaration.encoding) {
    const enc = tree.declaration.encoding.toUpperCase();
    if (enc !== 'UTF-8') warnings.push(`XML declares encoding ${enc}; ADM tooling expects UTF-8.`);
  }

  // ── Namespaces ──
  if (root.name === 'ebuCoreMain') {
    const ns = summary.defaultNamespace;
    if (!ns) {
      errors.push('<ebuCoreMain> has no default namespace declaration.');
    } else if (!/^urn:ebu:metadata-schema:ebuCore(_\d{4})?$/.test(ns)) {
      errors.push(`Unexpected EBU Core namespace "${ns}".`);
    }
    if (!findOne(root, 'coreMetadata')) errors.push('<ebuCoreMain> has no <coreMetadata>.');
  } else if (root.name !== 'frame' && root.name !== 'audioFormatExtended') {
    warnings.push(
      `Root element <${root.name}> is neither ebuCoreMain, frame, nor a bare ` +
        'audioFormatExtended — interchange partners may not accept it.',
    );
  }

  const afe = root.name === 'audioFormatExtended' ? root : findOne(root, 'audioFormatExtended');
  if (!afe) {
    errors.push('No <audioFormatExtended> element — this is not an ADM document.');
    return { valid: false, wellFormed: true, errors, warnings, summary };
  }
  summary.admVersion = afe.attrs.version ?? null;
  if (afe.attrs.version && !/^ITU-R_BS\.2076-\d+$/.test(afe.attrs.version)) {
    warnings.push(`audioFormatExtended version "${afe.attrs.version}" is not ITU-R_BS.2076-n.`);
  }

  // ── Element harvest ──
  const kinds = {
    audioProgramme: 'audioProgrammeID',
    audioContent: 'audioContentID',
    audioObject: 'audioObjectID',
    audioPackFormat: 'audioPackFormatID',
    audioChannelFormat: 'audioChannelFormatID',
    audioStreamFormat: 'audioStreamFormatID',
    audioTrackFormat: 'audioTrackFormatID',
    audioTrackUID: 'UID',
  };
  /** @type {Record<string, XmlNode[]>} */
  const els = {};
  /** @type {Map<string, string>} id → element kind */
  const ids = new Map();

  for (const [kind, idAttr] of Object.entries(kinds)) {
    els[kind] = findAll(afe, kind);
    summary.counts[kind] = els[kind].length;
    for (const el of els[kind]) {
      const id = el.attrs[idAttr];
      if (id === undefined) {
        errors.push(`<${kind}> is missing its required ${idAttr} attribute.`);
        continue;
      }
      const patternKey = kind === 'audioTrackUID' ? 'audioTrackUID' : idAttr;
      const pattern = ID_PATTERNS[patternKey];
      if (pattern && !pattern.test(id)) {
        errors.push(`${idAttr} "${id}" does not match the BS.2076 pattern ${pattern}.`);
      }
      if (ids.has(id)) errors.push(`Duplicate identifier "${id}" (${kind}).`);
      ids.set(id, kind);
    }
  }

  // Required *Name attributes.
  const nameAttrs = {
    audioProgramme: 'audioProgrammeName',
    audioContent: 'audioContentName',
    audioObject: 'audioObjectName',
    audioPackFormat: 'audioPackFormatName',
    audioChannelFormat: 'audioChannelFormatName',
    audioStreamFormat: 'audioStreamFormatName',
    audioTrackFormat: 'audioTrackFormatName',
  };
  for (const [kind, attr] of Object.entries(nameAttrs)) {
    for (const el of els[kind]) {
      if (!el.attrs[attr]) errors.push(`<${kind}> is missing the required ${attr} attribute.`);
      else if (el.attrs[attr].length > 512) {
        warnings.push(`${attr} is ${el.attrs[attr].length} characters — unusually long.`);
      }
    }
  }

  // ── Cross-references ──
  const refTargets = {
    audioContentIDRef: 'audioContent',
    audioObjectIDRef: 'audioObject',
    audioPackFormatIDRef: 'audioPackFormat',
    audioChannelFormatIDRef: 'audioChannelFormat',
    audioStreamFormatIDRef: 'audioStreamFormat',
    audioTrackFormatIDRef: 'audioTrackFormat',
    audioTrackUIDRef: 'audioTrackUID',
  };
  let refCount = 0;
  for (const [refName, targetKind] of Object.entries(refTargets)) {
    for (const ref of findAll(afe, refName)) {
      refCount++;
      const value = ref.text.trim();
      if (!value) {
        errors.push(`<${refName}> is empty.`);
        continue;
      }
      const kind = ids.get(value);
      if (!kind) {
        errors.push(`<${refName}> points at "${value}", which is not defined in this document.`);
      } else if (kind !== targetKind) {
        errors.push(
          `<${refName}> points at "${value}", which is a <${kind}>, not a <${targetKind}>.`,
        );
      }
    }
  }
  summary.counts.references = refCount;

  // ── typeLabel / typeDefinition consistency ──
  for (const kind of ['audioPackFormat', 'audioChannelFormat']) {
    for (const el of els[kind]) {
      const label = el.attrs.typeLabel;
      const def = el.attrs.typeDefinition;
      if (!label && !def) {
        errors.push(`<${kind}> declares neither typeLabel nor typeDefinition.`);
        continue;
      }
      if (def) summary.typeDefinitions.push(def);
      if (label && def && ADM_TYPE_LABELS[label] !== def) {
        errors.push(
          `<${kind} ${kinds[kind]}="${el.attrs[kinds[kind]]}"> has typeLabel="${label}" ` +
            `(${ADM_TYPE_LABELS[label] ?? 'unknown'}) but typeDefinition="${def}" — ` +
            'BS.2076 Table 8 requires these to agree.',
        );
      }
      // The ID's embedded type digits must match typeLabel too (BS.2076 §5.2).
      const id = el.attrs[kinds[kind]];
      if (label && id) {
        const embedded = /^A[CP]_([0-9A-Fa-f]{4})/.exec(id)?.[1];
        if (embedded && embedded.toUpperCase() !== label.toUpperCase()) {
          errors.push(
            `${kinds[kind]} "${id}" embeds type ${embedded} but typeLabel is "${label}".`,
          );
        }
      }
    }
  }
  summary.typeDefinitions = [...new Set(summary.typeDefinitions)];

  // ── DirectSpeakers semantics ──
  for (const cf of els.audioChannelFormat) {
    const def = cf.attrs.typeDefinition;
    const blocks = findAll(cf, 'audioBlockFormat');
    const id = cf.attrs.audioChannelFormatID ?? '(no id)';
    if (blocks.length === 0) {
      errors.push(`<audioChannelFormat ${id}> has no <audioBlockFormat>.`);
    }
    for (const b of blocks) {
      const bid = b.attrs.audioBlockFormatID;
      if (!bid) errors.push(`<audioBlockFormat> in ${id} has no audioBlockFormatID.`);
      else if (!bid.startsWith(`AB_${id.slice(3)}`)) {
        errors.push(
          `audioBlockFormatID "${bid}" does not derive from its parent channel format ${id} ` +
            '(BS.2076 requires AB_<channel-format-digits>_<counter>).',
        );
      }
      for (const attr of ['rtime', 'duration']) {
        if (b.attrs[attr] && !TIMECODE.test(b.attrs[attr])) {
          errors.push(`<audioBlockFormat ${bid}> ${attr}="${b.attrs[attr]}" is not a timecode.`);
        }
      }

      if (def !== 'DirectSpeakers') continue;

      const labels = findAll(b, 'speakerLabel');
      if (labels.length === 0) {
        errors.push(`DirectSpeakers block ${bid} has no <speakerLabel>.`);
      }
      for (const l of labels) {
        const t = l.text.trim();
        summary.speakerLabels.push(t);
        if (!t) errors.push(`<speakerLabel> in ${bid} is empty.`);
        else if (
          !BS2051_LABEL.test(t) &&
          !/^LFE\d?$/.test(t) &&
          !t.includes(':') &&
          !CUSTOM_LABEL.test(t)
        ) {
          warnings.push(
            `speakerLabel "${t}" is neither a BS.2051 label (e.g. M+030), an LFE label, ` +
              'nor a vendor-namespaced custom label (VENDOR_… or prefix:name) — ' +
              'interchange partners may not recognise it.',
          );
        }
      }

      // Positions: DirectSpeakers uses either polar (azimuth/elevation/distance) or
      // Cartesian (X/Y/Z). Mixing them is invalid.
      const positions = findAll(b, 'position');
      const coords = new Map();
      for (const p of positions) {
        const c = p.attrs.coordinate;
        if (!c) {
          errors.push(`<position> in ${bid} has no coordinate attribute.`);
          continue;
        }
        if (coords.has(c) && !p.attrs.bound) {
          errors.push(`<position coordinate="${c}"> appears twice unbounded in ${bid}.`);
        }
        const v = Number(p.text.trim());
        if (!Number.isFinite(v)) {
          errors.push(`<position coordinate="${c}"> in ${bid} is not a number ("${p.text}").`);
          continue;
        }
        coords.set(c, v);
        if (c === 'azimuth' && (v < -180 || v > 180)) {
          errors.push(`azimuth ${v} in ${bid} is outside (−180, 180].`);
        }
        if (c === 'elevation' && (v < -90 || v > 90)) {
          errors.push(`elevation ${v} in ${bid} is outside [−90, 90].`);
        }
        if (c === 'distance' && (v < 0 || v > 1.0000001)) {
          errors.push(`distance ${v} in ${bid} is outside [0, 1].`);
        }
        if (['X', 'Y', 'Z'].includes(c) && (v < -1.0000001 || v > 1.0000001)) {
          errors.push(`Cartesian ${c} ${v} in ${bid} is outside [−1, 1].`);
        }
      }
      const polar = ['azimuth', 'elevation'].filter((c) => coords.has(c));
      const cart = ['X', 'Y', 'Z'].filter((c) => coords.has(c));
      if (polar.length && cart.length) {
        errors.push(`${bid} mixes polar and Cartesian coordinates.`);
      }
      if (!polar.length && !cart.length) {
        errors.push(`DirectSpeakers block ${bid} declares no position.`);
      }
      if (polar.length === 1) {
        errors.push(`${bid} declares ${polar[0]} without the other polar coordinate.`);
      }

      // Coordinate ⇄ speakerLabel agreement: an M+030 label must sit near azimuth +30.
      const label = labels[0]?.text.trim() ?? '';
      const m = BS2051_LABEL.exec(label);
      if (m && coords.has('azimuth')) {
        const declared = Number(label.slice(1));
        const actual = coords.get('azimuth');
        // Compare on the circle so ±180 does not read as a 360° error.
        const delta = Math.abs(((((declared - actual + 180) % 360) + 360) % 360) - 180);
        if (delta > 5) {
          errors.push(
            `speakerLabel "${label}" implies azimuth ${declared}° but the block declares ` +
              `${actual}° (BS.2076 positive azimuth is anticlockwise/LEFT). ` +
              'A sign error here mirror-images the delivery.',
          );
        }
        const layer = label[0];
        const el = coords.get('elevation') ?? 0;
        if (layer === 'M' && Math.abs(el) > 15) {
          warnings.push(`"${label}" is a middle-layer label but elevation is ${el}°.`);
        }
        if (layer === 'U' && el <= 0) {
          errors.push(`"${label}" is an upper-layer label but elevation is ${el}°.`);
        }
        if (layer === 'B' && el >= 0) {
          errors.push(`"${label}" is a bottom-layer label but elevation is ${el}°.`);
        }
      }

      // LFE: a low-frequency channel should carry a lowPass frequency element.
      // BS.2051 spells these `LFE1`/`LFE2`; a venue rig with several discrete subwoofers
      // has no ITU label at all, so a vendor-namespaced label containing SUB counts too.
      if (isLowFrequencyLabel(label)) {
        const freq = findAll(b, 'frequency').filter((f) => f.attrs.typeDefinition === 'lowPass');
        if (freq.length === 0) {
          warnings.push(`LFE channel ${id} has no <frequency typeDefinition="lowPass">.`);
        } else {
          const hz = Number(freq[0].text.trim());
          if (!Number.isFinite(hz) || hz <= 0 || hz > 300) {
            errors.push(`LFE lowPass frequency "${freq[0].text}" in ${id} is implausible.`);
          }
        }
      } else if (findAll(b, 'frequency').length) {
        warnings.push(
          `Channel ${id} (speakerLabel "${label}") declares a <frequency> element but is ` +
            'not identifiable as a low-frequency channel from its label.',
        );
      }
    }
  }

  // ── Pack ⇄ channel ⇄ stream ⇄ track ⇄ UID chain ──
  const packs = els.audioPackFormat;
  if (packs.length === 0) errors.push('No <audioPackFormat>.');
  for (const p of packs) {
    const refs = findAll(p, 'audioChannelFormatIDRef');
    if (refs.length === 0) {
      warnings.push(
        `<audioPackFormat ${p.attrs.audioPackFormatID}> references no channel formats ` +
          'and no sub-packs.',
      );
    }
  }

  const streamByChannel = new Map();
  for (const sf of els.audioStreamFormat) {
    const cfRef = findOne(sf, 'audioChannelFormatIDRef')?.text.trim();
    if (!cfRef) {
      errors.push(
        `<audioStreamFormat ${sf.attrs.audioStreamFormatID}> has no audioChannelFormatIDRef.`,
      );
    } else if (streamByChannel.has(cfRef)) {
      errors.push(`Two audioStreamFormats reference audioChannelFormat "${cfRef}".`);
    } else streamByChannel.set(cfRef, sf.attrs.audioStreamFormatID);
    if (sf.attrs.formatDefinition && sf.attrs.formatLabel) {
      const fl = sf.attrs.formatLabel;
      const fd = sf.attrs.formatDefinition;
      if ((fl === '0001') !== (fd === 'PCM')) {
        errors.push(`audioStreamFormat formatLabel "${fl}" and formatDefinition "${fd}" disagree.`);
      }
    }
  }

  // Every channel format must be reachable from exactly one stream format.
  for (const cf of els.audioChannelFormat) {
    const id = cf.attrs.audioChannelFormatID;
    if (id && !streamByChannel.has(id)) {
      warnings.push(`audioChannelFormat "${id}" is not referenced by any audioStreamFormat.`);
    }
  }

  // audioTrackUID ⇄ track format, and the sampleRate/bitDepth cross-check.
  const uids = [];
  for (const u of els.audioTrackUID) {
    const uid = u.attrs.UID;
    uids.push(uid);
    if (!findOne(u, 'audioTrackFormatIDRef') && !findOne(u, 'audioChannelFormatIDRef')) {
      errors.push(`<audioTrackUID ${uid}> references neither a track nor a channel format.`);
    }
    if (u.attrs.sampleRate !== undefined) {
      const sr = Number(u.attrs.sampleRate);
      if (!Number.isInteger(sr) || sr <= 0) {
        errors.push(`<audioTrackUID ${uid}> sampleRate "${u.attrs.sampleRate}" is invalid.`);
      } else if (opts.sampleRate && sr !== opts.sampleRate) {
        errors.push(
          `<audioTrackUID ${uid}> declares ${sr} Hz but the WAV fmt chunk says ` +
            `${opts.sampleRate} Hz.`,
        );
      }
    }
    if (u.attrs.bitDepth !== undefined) {
      const bd = Number(u.attrs.bitDepth);
      if (![16, 24, 32].includes(bd)) {
        warnings.push(`<audioTrackUID ${uid}> declares an unusual bitDepth ${bd}.`);
      } else if (opts.bitDepth && bd !== opts.bitDepth) {
        errors.push(
          `<audioTrackUID ${uid}> declares ${bd}-bit but the WAV fmt chunk says ${opts.bitDepth}.`,
        );
      }
    }
  }
  summary.trackUids = uids;

  // ── Programme / content / object chain ──
  if (els.audioProgramme.length === 0) warnings.push('No <audioProgramme>.');
  if (els.audioProgramme.length > 1) {
    warnings.push(`${els.audioProgramme.length} audioProgrammes — most renderers expect one.`);
  }
  for (const pr of els.audioProgramme) {
    for (const attr of ['start', 'end']) {
      if (pr.attrs[attr] && !TIMECODE.test(pr.attrs[attr])) {
        errors.push(`<audioProgramme> ${attr}="${pr.attrs[attr]}" is not a timecode.`);
      }
    }
    if (findAll(pr, 'audioContentIDRef').length === 0) {
      errors.push(`<audioProgramme ${pr.attrs.audioProgrammeID}> references no audioContent.`);
    }
  }
  for (const co of els.audioContent) {
    if (findAll(co, 'audioObjectIDRef').length === 0) {
      errors.push(`<audioContent ${co.attrs.audioContentID}> references no audioObject.`);
    }
  }
  for (const ob of els.audioObject) {
    if (findAll(ob, 'audioPackFormatIDRef').length === 0) {
      errors.push(`<audioObject ${ob.attrs.audioObjectID}> references no audioPackFormat.`);
    }
  }

  // ── Cross-checks against the container ──
  if (opts.expectedChannels !== undefined) {
    if (els.audioChannelFormat.length !== opts.expectedChannels) {
      errors.push(
        `ADM declares ${els.audioChannelFormat.length} audioChannelFormats but the WAV has ` +
          `${opts.expectedChannels} channels.`,
      );
    }
    if (els.audioTrackUID.length !== opts.expectedChannels) {
      errors.push(
        `ADM declares ${els.audioTrackUID.length} audioTrackUIDs but the WAV has ` +
          `${opts.expectedChannels} channels.`,
      );
    }
  }
  if (opts.expectedTrackUids) {
    const inXml = new Set(uids);
    for (const u of opts.expectedTrackUids) {
      if (!inXml.has(u)) errors.push(`chna declares audioTrackUID "${u}" which the axml lacks.`);
    }
    const inChna = new Set(opts.expectedTrackUids);
    for (const u of uids) {
      if (!inChna.has(u)) errors.push(`axml declares audioTrackUID "${u}" which the chna lacks.`);
    }
  }

  // ── Duplicate speaker positions: two channels at the same place is a routing bug ──
  const positionKeys = new Map();
  for (const cf of els.audioChannelFormat) {
    const b = findOne(cf, 'audioBlockFormat');
    if (!b) continue;
    const az = findAll(b, 'position').find((p) => p.attrs.coordinate === 'azimuth');
    const el = findAll(b, 'position').find((p) => p.attrs.coordinate === 'elevation');
    if (!az || !el) continue;
    const key = `${Number(az.text)}/${Number(el.text)}`;
    const label = findOne(b, 'speakerLabel')?.text.trim() ?? '';
    // Multiple subwoofers legitimately share a nominal position.
    if (isLowFrequencyLabel(label)) continue;
    if (positionKeys.has(key)) {
      warnings.push(
        `audioChannelFormats ${positionKeys.get(key)} and ${cf.attrs.audioChannelFormatID} ` +
          `declare the same position (${key}).`,
      );
    } else positionKeys.set(key, cf.attrs.audioChannelFormatID);
  }

  summary.speakerLabels = [...new Set(summary.speakerLabels)];
  return { valid: errors.length === 0, wellFormed: true, errors, warnings, summary };
}
