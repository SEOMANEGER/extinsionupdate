/* Maps license-server project_type (API) to display names on this site only. */
(function () {
  var MAP = {
    Quotex: 'Mega X Version',
    'Quotex Low Quality': 'Mega Version',
  };
  window.projectLabel = function (apiValue) {
    if (apiValue == null || apiValue === '') return '—';
    return MAP[apiValue] || apiValue;
  };
})();
