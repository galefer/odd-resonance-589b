import { mountCardViewer } from './card-viewer.js';

const $ = (selector) => document.querySelector(selector);

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function applyConfig(config) {
  const settings = config.settings || {};
  const version = config.version;
  $('#brand-short-name').textContent = settings.format_short_name || 'Guild of Games';
  $('#brand-store-name').textContent = 'Yu-Gi-Oh! JUSH House Format';
  $('#format-name').textContent = settings.format_name || 'Yu-Gi-Oh! JUSH House Format';
  $('#format-description').textContent = settings.format_description || 'A Guild of Games format using the Justice Hunters card pool and an altered Forbidden & Limited List based on the JUSH-era banlist.';
  $('#accent-label').textContent = settings.accent_label || 'Guild of Games';
  $('#footer-format-name').textContent = settings.format_name || 'Yu-Gi-Oh! JUSH House Format';
  $('#version-label').textContent = version?.label || 'Foundation';
  $('#mobile-version-label').textContent = version?.label || 'Foundation';
  $('#effective-date').textContent = formatDate(version?.effectiveDate);
  $('#effective-date').dateTime = version?.effectiveDate || '';
  const cutoff = config.cardPool.cutoffDate;
  $('#pool-cutoff').textContent = formatDate(cutoff).replace(/\s(\d{4})$/, ' $1');
  $('#pool-cutoff').dateTime = cutoff;
  $('#footer-version').textContent = `Version ${version?.label || 'Foundation'}`;
  document.title = `${settings.format_name || 'Yu-Gi-Oh! JUSH House Format'} · Guild of Games`;
}

mountCardViewer($('#card-viewer'), { onConfig: applyConfig });
$('#hero-check-card').addEventListener('click', () => requestAnimationFrame(() => $('#card-search').focus()));
