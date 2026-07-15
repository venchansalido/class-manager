// js/export.js
//
// Gradebook export (Excel) for a section. Reachable from the "Export"
// button in the shared Assessments/Summary toolbar (see grades.js).
//
// The Excel library is NOT bundled — this app has no build step and
// index.html only loads js/app.js. Instead we lazy-load ExcelJS from a CDN
// the first time an export is actually requested, so the library code
// never touches page load for the (probably rare) common case of never
// exporting.
//
// Excel uses ExcelJS rather than SheetJS specifically because it supports
// real cell styling (fills, fonts, borders, merged multi-row headers,
// conditional formatting) — SheetJS's free build writes values only. The
// visual theme (colors, category tints) mirrors css/styles.css so the
// exported file feels like the same product, not a generic spreadsheet.
//
// (A PDF export previously lived here too, but jspdf-autotable's CDN was
// unreliable in practice, so PDF support was dropped — Excel covers the
// need on its own.)
//
// Weighted-average math here intentionally mirrors loadAndRenderSummary in
// grades.js exactly (same "category with zero scores excluded from both
// numerator and denominator" rule) — if that logic ever changes, update
// both places.

import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';

// Colors mirror css/styles.css custom properties. Each category also
// carries the hex (no '#', Excel ARGB-ready) form of its category-badge
// color from styles.css (.category-badge--<key>).
const CATEGORIES = [
  { key: 'quiz',      label: 'Quiz',      hex: '3F7A54', bgHex: 'E5F0E7' },
  { key: 'exam',      label: 'Exam',      hex: 'B4463B', bgHex: 'F7E6E3' },
  { key: 'summative', label: 'Summative', hex: '4C6FA6', bgHex: 'E6ECF5' },
  { key: 'activity',  label: 'Activity',  hex: 'B4801F', bgHex: 'F7EBD2' },
  { key: 'other',     label: 'Other',     hex: '6E6858', bgHex: 'F1EAD8' },
];

const THEME = {
  hex: {
    primary: 'FF2F4A3B', primaryDark: 'FF203327', accent: 'FFC89B3C', accentSoft: 'FFF4E7C7',
    ink: 'FF22301F', muted: 'FF6E6858', border: 'FFE4DCC5', bgDeep: 'FFF1EAD8', white: 'FFFFFFFF',
    presentBg: 'FFE5F0E7', lateBg: 'FFF7EBD2', absentBg: 'FFF7E6E3',
  },
};

const CDN = {
  exceljs: 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
};

const scriptPromises = {};

function loadScript(src) {
  if (scriptPromises[src]) return scriptPromises[src];
  scriptPromises[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
      if (existing.dataset.loaded === 'true') resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.addEventListener('load', () => { el.dataset.loaded = 'true'; resolve(); });
    el.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
    document.head.appendChild(el);
  });
  return scriptPromises[src];
}

// ---------------------------------------------------------------------------
// Entry point: called directly from the toolbar's "Export" button.
// ---------------------------------------------------------------------------

export async function exportGradebookExcel(sectionId, sectionName, triggerBtn) {
  const originalLabel = triggerBtn ? triggerBtn.innerHTML : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Preparing…';
  }
  try {
    await exportExcel(sectionId, sectionName);
    showToast('Gradebook exported.', 'success');
  } catch (err) {
    console.error('Export error:', err);
    showToast(err.message || 'Export failed. Please try again.', 'error');
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = originalLabel;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared data assembly (mirrors grades.js loadAndRenderSummary)
// ---------------------------------------------------------------------------

async function loadGradebookData(sectionId) {
  const [
    { data: students, error: studentsError },
    { data: assessments, error: assessmentsError },
    { data: weightRows, error: weightsError },
  ] = await Promise.all([
    supabase.from('students').select('id, name').eq('section_id', sectionId).order('name', { ascending: true }),
    supabase.from('assessments').select('id, title, category, max_score, date').eq('section_id', sectionId),
    supabase.from('category_weights').select('category, weight').eq('section_id', sectionId),
  ]);

  if (studentsError) throw studentsError;
  if (assessmentsError) throw assessmentsError;
  if (weightsError) throw weightsError;

  if (!students || students.length === 0) {
    throw new Error('No students in this section yet — nothing to export.');
  }

  // Chronological order reads naturally as spreadsheet/table columns.
  const sortedAssessments = [...(assessments || [])].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  let scoresByAssessment = new Map();
  if (sortedAssessments.length > 0) {
    const assessmentIds = sortedAssessments.map((a) => a.id);
    const { data: scores, error: scoresError } = await supabase
      .from('scores')
      .select('assessment_id, student_id, score')
      .in('assessment_id', assessmentIds);
    if (scoresError) throw scoresError;

    (scores || []).forEach((s) => {
      if (!scoresByAssessment.has(s.assessment_id)) scoresByAssessment.set(s.assessment_id, new Map());
      scoresByAssessment.get(s.assessment_id).set(s.student_id, s.score);
    });
  }

  const assessmentsByCategory = new Map();
  sortedAssessments.forEach((a) => {
    if (!assessmentsByCategory.has(a.category)) assessmentsByCategory.set(a.category, []);
    assessmentsByCategory.get(a.category).push(a);
  });

  const weightMap = new Map((weightRows || []).map((w) => [w.category, w.weight]));
  const usingDefaultWeights = weightMap.size === 0;
  const defaultWeight = 100 / CATEGORIES.length;

  const studentRows = students.map((student) => {
    const breakdown = CATEGORIES.map((c) => {
      const catAssessments = assessmentsByCategory.get(c.key) || [];
      let sumPct = 0;
      let count = 0;
      catAssessments.forEach((a) => {
        const score = scoresByAssessment.get(a.id)?.get(student.id);
        if (score != null) {
          sumPct += (score / a.max_score) * 100;
          count += 1;
        }
      });
      return {
        key: c.key,
        label: c.label,
        weight: usingDefaultWeights ? defaultWeight : (weightMap.get(c.key) ?? 0),
        avg: count > 0 ? sumPct / count : null,
        count,
        total: catAssessments.length,
      };
    });

    const graded = breakdown.filter((b) => b.avg != null);
    const weightSum = graded.reduce((sum, b) => sum + b.weight, 0);
    const overall = weightSum > 0
      ? graded.reduce((sum, b) => sum + b.avg * b.weight, 0) / weightSum
      : null;

    const rawScores = new Map(
      sortedAssessments.map((a) => [a.id, scoresByAssessment.get(a.id)?.get(student.id) ?? null])
    );

    return { student, breakdown, overall, rawScores };
  });

  const graded = studentRows.filter((r) => r.overall != null);
  const classAvg = graded.length > 0
    ? graded.reduce((sum, r) => sum + r.overall, 0) / graded.length
    : null;
  let highest = null;
  let lowest = null;
  graded.forEach((r) => {
    if (!highest || r.overall > highest.overall) highest = r;
    if (!lowest || r.overall < lowest.overall) lowest = r;
  });

  return { students: studentRows, assessments: sortedAssessments, usingDefaultWeights, classAvg, highest, lowest };
}

// ---------------------------------------------------------------------------
// Excel export (ExcelJS) — two styled sheets: raw Scores matrix + weighted
// Summary, both with a letterhead banner, colored category-coded headers,
// zebra striping, frozen panes, and an autofilter / conditional color scale
// on the Summary sheet's Overall % column.
// ---------------------------------------------------------------------------

async function exportExcel(sectionId, sectionName) {
  const data = await loadGradebookData(sectionId);
  await loadScript(CDN.exceljs);
  const ExcelJS = window.ExcelJS;
  if (!ExcelJS) throw new Error('Could not load the Excel export library. Check your connection.');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Roll Call';
  wb.created = new Date();

  buildScoresSheet(wb, data, sectionName);
  buildSummarySheet(wb, data, sectionName);

  const buffer = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), `${fileSafe(sectionName)}-gradebook.xlsx`);
}

function generatedLine(data) {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `Generated ${date} \u00b7 ${data.students.length} student${data.students.length === 1 ? '' : 's'} \u00b7 ${data.assessments.length} assessment${data.assessments.length === 1 ? '' : 's'}`;
}

function buildScoresSheet(wb, data, sectionName) {
  const colCount = 1 + data.assessments.length;
  const ws = wb.addWorksheet('Scores');

  // --- Letterhead ---
  ws.mergeCells(1, 1, 1, colCount);
  styleCell(ws.getCell(1, 1), {
    value: `${sectionName} \u2014 Gradebook`,
    bold: true, size: 15, color: THEME.hex.white, fill: THEME.hex.primary,
    align: { vertical: 'middle', horizontal: 'left', indent: 1 },
  });
  ws.getRow(1).height = 27;

  ws.mergeCells(2, 1, 2, colCount);
  styleCell(ws.getCell(2, 1), {
    value: generatedLine(data),
    italic: true, size: 10, color: THEME.hex.muted, fill: THEME.hex.bgDeep,
    align: { vertical: 'middle', horizontal: 'left', indent: 1 },
  });
  ws.getRow(2).height = 18;

  // --- Header row ---
  const headerRowIdx = 3;
  styleCell(ws.getCell(headerRowIdx, 1), {
    value: 'Student', bold: true, color: THEME.hex.white, fill: THEME.hex.primaryDark,
    align: { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true },
    border: THEME.hex.primaryDark,
  });
  data.assessments.forEach((a, j) => {
    const cat = categoryMeta(a.category);
    styleCell(ws.getCell(headerRowIdx, 2 + j), {
      value: `${a.title}\n${cat.label} \u00b7 ${formatDateForSheet(a.date)}\nout of ${formatNumber(a.max_score)}`,
      bold: true, size: 10, color: cat.hex, fill: cat.bgHex,
      align: { vertical: 'middle', horizontal: 'center', wrapText: true },
      border: THEME.hex.border,
    });
  });
  ws.getRow(headerRowIdx).height = 48;

  // --- Data rows ---
  data.students.forEach((r, i) => {
    const rowIdx = headerRowIdx + 1 + i;
    const zebra = i % 2 === 0 ? THEME.hex.white : THEME.hex.bgDeep;

    styleCell(ws.getCell(rowIdx, 1), {
      value: r.student.name, bold: true, color: THEME.hex.ink, fill: zebra,
      align: { vertical: 'middle', horizontal: 'left', indent: 1 },
      border: THEME.hex.border,
    });

    data.assessments.forEach((a, j) => {
      const v = r.rawScores.get(a.id);
      const cell = ws.getCell(rowIdx, 2 + j);
      if (v != null) { cell.value = v; cell.numFmt = '0.##'; }
      styleCell(cell, {
        color: THEME.hex.ink, fill: zebra,
        align: { vertical: 'middle', horizontal: 'center' },
        border: THEME.hex.border,
      });
    });
  });

  ws.getColumn(1).width = 24;
  data.assessments.forEach((_, j) => { ws.getColumn(2 + j).width = 18; });

  ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: colCount } };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headerRowIdx }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function buildSummarySheet(wb, data, sectionName) {
  const colCount = 2 + CATEGORIES.length * 2; // student + (avg,weight) per category + overall
  const overallCol = colCount;
  const ws = wb.addWorksheet('Summary');

  // --- Letterhead ---
  ws.mergeCells(1, 1, 1, colCount);
  styleCell(ws.getCell(1, 1), {
    value: `${sectionName} \u2014 Grade Summary`,
    bold: true, size: 15, color: THEME.hex.white, fill: THEME.hex.primary,
    align: { vertical: 'middle', horizontal: 'left', indent: 1 },
  });
  ws.getRow(1).height = 27;

  let subtitle = generatedLine(data);
  if (data.usingDefaultWeights) subtitle += ' \u00b7 no custom weights saved, even split used';
  ws.mergeCells(2, 1, 2, colCount);
  styleCell(ws.getCell(2, 1), {
    value: subtitle, italic: true, size: 10, color: THEME.hex.muted, fill: THEME.hex.bgDeep,
    align: { vertical: 'middle', horizontal: 'left', indent: 1 },
  });
  ws.getRow(2).height = 18;

  // --- Class stat line ---
  ws.mergeCells(3, 1, 3, colCount);
  const statText = data.classAvg != null
    ? `Class average: ${formatNumber(data.classAvg)}%   \u00b7   Highest: ${data.highest.student.name} (${formatNumber(data.highest.overall)}%)   \u00b7   Lowest: ${data.lowest.student.name} (${formatNumber(data.lowest.overall)}%)`
    : 'No grades recorded yet for this section.';
  styleCell(ws.getCell(3, 1), {
    value: statText, bold: true, size: 10.5, color: THEME.hex.primaryDark, fill: THEME.hex.accentSoft,
    align: { vertical: 'middle', horizontal: 'left', indent: 1 },
  });
  ws.getRow(3).height = 20;

  // --- Two-row header: category group row, then Avg%/Weight% sub-row ---
  const groupRow = 4;
  const subRow = 5;

  ws.mergeCells(groupRow, 1, subRow, 1);
  styleCell(ws.getCell(groupRow, 1), {
    value: 'Student', bold: true, color: THEME.hex.white, fill: THEME.hex.primaryDark,
    align: { vertical: 'middle', horizontal: 'left', indent: 1 }, border: THEME.hex.primaryDark,
  });

  CATEGORIES.forEach((c, k) => {
    const start = 2 + k * 2;
    ws.mergeCells(groupRow, start, groupRow, start + 1);
    styleCell(ws.getCell(groupRow, start), {
      value: c.label, bold: true, color: THEME.hex.white, fill: c.hex,
      align: { vertical: 'middle', horizontal: 'center' }, border: c.hex,
    });
    styleCell(ws.getCell(subRow, start), {
      value: 'Avg %', bold: true, size: 9.5, color: c.hex, fill: c.bgHex,
      align: { vertical: 'middle', horizontal: 'center' }, border: THEME.hex.border,
    });
    styleCell(ws.getCell(subRow, start + 1), {
      value: 'Weight %', bold: true, size: 9.5, color: c.hex, fill: c.bgHex,
      align: { vertical: 'middle', horizontal: 'center' }, border: THEME.hex.border,
    });
  });

  ws.mergeCells(groupRow, overallCol, subRow, overallCol);
  styleCell(ws.getCell(groupRow, overallCol), {
    value: 'Overall %', bold: true, color: THEME.hex.white, fill: THEME.hex.accent,
    align: { vertical: 'middle', horizontal: 'center' }, border: THEME.hex.accent,
  });

  ws.getRow(groupRow).height = 20;
  ws.getRow(subRow).height = 18;

  // --- Data rows ---
  data.students.forEach((r, i) => {
    const rowIdx = subRow + 1 + i;
    const zebra = i % 2 === 0 ? THEME.hex.white : THEME.hex.bgDeep;

    styleCell(ws.getCell(rowIdx, 1), {
      value: r.student.name, bold: true, color: THEME.hex.ink, fill: zebra,
      align: { vertical: 'middle', horizontal: 'left', indent: 1 }, border: THEME.hex.border,
    });

    r.breakdown.forEach((b, k) => {
      const start = 2 + k * 2;
      const avgCell = ws.getCell(rowIdx, start);
      if (b.avg != null) { avgCell.value = round2(b.avg); avgCell.numFmt = '0.0"%"'; }
      styleCell(avgCell, { color: THEME.hex.ink, fill: zebra, align: { horizontal: 'center', vertical: 'middle' }, border: THEME.hex.border });

      const weightCell = ws.getCell(rowIdx, start + 1);
      weightCell.value = round2(b.weight);
      weightCell.numFmt = '0.0"%"';
      styleCell(weightCell, { color: THEME.hex.muted, fill: zebra, align: { horizontal: 'center', vertical: 'middle' }, border: THEME.hex.border });
    });

    const overallCell = ws.getCell(rowIdx, overallCol);
    if (r.overall != null) { overallCell.value = round2(r.overall); overallCell.numFmt = '0.0"%"'; }
    styleCell(overallCell, {
      bold: true, size: 11, color: THEME.hex.primaryDark, fill: zebra,
      align: { horizontal: 'center', vertical: 'middle' }, border: THEME.hex.border,
    });
  });

  ws.getColumn(1).width = 24;
  for (let k = 0; k < CATEGORIES.length; k++) {
    ws.getColumn(2 + k * 2).width = 11;
    ws.getColumn(3 + k * 2).width = 12;
  }
  ws.getColumn(overallCol).width = 12;

  const lastRow = subRow + data.students.length;
  if (lastRow > subRow) {
    ws.addConditionalFormatting({
      ref: `${colLetter(overallCol)}${subRow + 1}:${colLetter(overallCol)}${lastRow}`,
      rules: [{
        type: 'colorScale',
        cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
        color: [{ argb: THEME.hex.absentBg }, { argb: THEME.hex.lateBg }, { argb: THEME.hex.presentBg }],
      }],
    });
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: subRow }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function styleCell(cell, { value, bold, italic, size, color, fill, align, border }) {
  if (value !== undefined) cell.value = value;
  cell.font = { bold: !!bold, italic: !!italic, size: size || 11, color: { argb: color || THEME.hex.ink } };
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  if (align) cell.alignment = align;
  if (border) {
    const style = { style: 'thin', color: { argb: border } };
    cell.border = { top: style, bottom: style, left: style, right: style };
  }
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function categoryMeta(key) {
  return CATEGORIES.find((c) => c.key === key) || CATEGORIES[CATEGORIES.length - 1];
}

// ---------------------------------------------------------------------------
// Local helpers (duplicated intentionally, per project convention)
// ---------------------------------------------------------------------------

function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return Number.isInteger(num) ? String(num) : String(parseFloat(num.toFixed(2)));
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatDateForSheet(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fileSafe(str) {
  return (str || 'section').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'section';
}