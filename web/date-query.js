"use strict";

const dateQuery = (() => {
  const archive = ["2000-11-01", "2026-08-31"];
  const pilot = ["2026-11-08", "2026-11-15"];
  const params = new URLSearchParams(location.search);

  function readDate(name, fallback) {
    const value = params.get(name);
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
    const date = new Date(value + "T12:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      ? value : fallback;
  }

  function overlaps(start, end, [first, last]) {
    return start <= last && end >= first;
  }

  function url(path, start, end, region) {
    return path + "?" + new URLSearchParams({desde: start, hasta: end, region});
  }

  function updateLink(container, enabled, path, start, end, region) {
    container.hidden = !enabled;
    if (enabled) container.querySelector("a").href = url(path, start, end, region);
  }

  function restoreRegion(select) {
    const region = params.get("region");
    if ([...select.options].some(option => option.value === region)) select.value = region;
  }

  return {archive, pilot, readDate, overlaps, url, updateLink, restoreRegion};
})();
