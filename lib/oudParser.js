'use strict';

// Clean-room parser for OuDia/OuDiaSecond's .oud/.oud2 text format. Written
// from scratch against real (non-confidential) sample files under
// Diagram/（see NOTES.md「サンプルデータの扱い」/「.oud2フォーマット構造メモ」
// for the license reasoning and how this structure was derived）— no
// OuDiaParser/clouddia source was read or referenced.
//
// Status: the outer dot-hierarchy and station/train-identity extraction are
// solid (verified against real files). The EkiJikoku field (per-station
// arrival/departure times) is NOT decoded yet — the encoding is denser than
// "one $-segment per station" and needs minimal controlled test files to
// pin down safely (see NOTES.md). Until then, `stops` is intentionally left
// null on every train rather than guessing and risking silently-wrong times.

// Strips a leading UTF-8 BOM if present (all real sample files had one).
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Parses the dot-hierarchy into a generic tree: `Block.` opens a named
// block, a lone `.` line closes the innermost open block, `key=value` sets a
// property on the current block. Repeated block names become an array.
// Returns { props: {...}, children: { blockName: [node, ...] } }.
function parseTree(text) {
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  const root = { props: {}, children: {} };
  const stack = [root];

  for (const line of lines) {
    if (line === '') continue;
    if (line === '.') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const eq = line.indexOf('=');
    // A block-open line has no '=' and ends with '.' (e.g. "Rosen.", "Eki.").
    if (eq === -1 && line.endsWith('.')) {
      const name = line.slice(0, -1);
      const node = { props: {}, children: {} };
      const parent = stack[stack.length - 1];
      (parent.children[name] || (parent.children[name] = [])).push(node);
      stack.push(node);
      continue;
    }
    if (eq !== -1) {
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      stack[stack.length - 1].props[key] = value;
    }
    // Lines matching neither pattern (shouldn't happen in a well-formed
    // file) are silently skipped rather than throwing — a single unknown
    // line shouldn't abort an otherwise-readable import.
  }
  return root;
}

function firstChild(node, name) {
  const list = node.children[name];
  return list && list.length > 0 ? list[0] : null;
}

function allChildren(node, name) {
  return node.children[name] || [];
}

// Extracts station list + train identities (number/direction only — see
// module comment re: EkiJikoku). Returns null if the file doesn't look like
// a Rosen-based OuDia diagram at all (rather than throwing on unrelated text
// files a user might mistakenly pick).
function parseDiagram(text) {
  const tree = parseTree(text);
  const rosen = firstChild(tree, 'Rosen');
  if (!rosen) return null;

  const stations = allChildren(rosen, 'Eki').map((eki, index) => ({
    index,
    name: eki.props['Ekimei'] || '',
    shortName: eki.props['EkimeiJikokuRyaku'] || '',
    displayFormat: eki.props['Ekijikokukeisiki'] || null,
    downMain: eki.props['DownMain'] || null,
    upMain: eki.props['UpMain'] || null,
  }));

  const dia = firstChild(rosen, 'Dia');
  const trains = [];
  if (dia) {
    for (const dirBlockName of ['Kudari', 'Nobori']) {
      const dirBlock = firstChild(dia, dirBlockName);
      if (!dirBlock) continue;
      for (const ressya of allChildren(dirBlock, 'Ressya')) {
        trains.push({
          number: ressya.props['Ressyabangou'] || '',
          direction: dirBlockName === 'Kudari' ? 'down' : 'up',
          stops: null, // TODO: EkiJikoku decoding not confirmed yet, see NOTES.md
          _ekiJikokuRaw: ressya.props['EkiJikoku'] || '',
        });
      }
    }
  }

  return {
    lineName: rosen.props['Rosenmei'] || '',
    stations,
    trains,
    timesSupported: false, // surfaced to the UI so it never presents stops as real data
  };
}

module.exports = { parseTree, parseDiagram };
