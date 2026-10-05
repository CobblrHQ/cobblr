import type { ProgramPlacement, PlacementProfile } from "./placement-program.js";
export function placementCoverageText(placements: ProgramPlacement[], side: "top" | "bottom", profile: PlacementProfile) {
  const num = (v: number) => String(Math.round(v * 10000) / 10000);
  const boards = [...new Set(placements.map(p => p.board))].map(board => `frame|${board}|${num(profile.panel_origin_x_mm + ((board - 1) % profile.columns) * (profile.width_mm + profile.gap_mm))}|${num(profile.panel_origin_y_mm + Math.floor((board - 1) / profile.columns) * (profile.height_mm + profile.gap_mm))}|0|${side}`);
  return [...boards, ...placements.filter(p => p.side === side).map(p => `${p.board}|${p.ref}|${p.part_id}|${num(p.x_mm)}|${num(p.y_mm)}|${num(p.rotation)}|${p.side}`)].sort().join("\n");
}
export function openpnpObserverScripts(machineKind: string, machineId: string) {
  const script = (operation: "start" | "done") => `var System = Java.type('java.lang.System');
var Files = Java.type('java.nio.file.Files');
var Paths = Java.type('java.nio.file.Paths');
var JString = Java.type('java.lang.String');
var URL = Java.type('java.net.URL');
var Digest = Java.type('java.security.MessageDigest');
var name = String(job.getFile().getName());
var matched = /^([a-f0-9-]{36})-(top|bottom)\\.job\\.xml$/.exec(name);
if (matched) {
  var side = matched[2], rows = [], locations = job.getBoardLocations();
  function number(v) { return String(Math.round(Number(v) * 10000) / 10000); }
  for (var i = 0; i < locations.size(); i++) {
    var bl = locations.get(i);
    if (!bl.isEnabled()) continue;
    if (String(bl.getSide()).toLowerCase() !== side) throw new Error('The board side does not match this assembly job.');
    var filename = String(bl.getBoard().getFile().getName());
    var boardNumber = /^board-(\\d+)\\.board\\.xml$/.exec(filename);
    if (!boardNumber) throw new Error('Use the exported board files for this work order.');
    var frame = bl.getLocation().convertToUnits(Java.type('org.openpnp.model.LengthUnit').Millimeters);
    rows.push(['frame', Number(boardNumber[1]), number(frame.getX()), number(frame.getY()), number(((Number(frame.getRotation()) % 360) + 360) % 360), side].join('|'));
    var ps = bl.getBoard().getPlacements();
    for (var j = 0; j < ps.size(); j++) {
      var p = ps.get(j);
      if (!p.isEnabled() || String(p.getType()) !== 'Placement' || String(p.getSide()).toLowerCase() !== side) continue;
      ${operation === "done" ? "if (!job.retrievePlacedStatus(bl, p.getId())) continue;" : ""}
      var part = String(p.getPart().getId());
      if (part.indexOf('reel-') !== 0) throw new Error('Use the reel parts from the exported feeder map.');
      var loc = p.getLocation().convertToUnits(Java.type('org.openpnp.model.LengthUnit').Millimeters);
      var rotation = ((Number(loc.getRotation()) % 360) + 360) % 360;
      rows.push([Number(boardNumber[1]), String(p.getId()), part.substring(5), number(loc.getX()), number(loc.getY()), number(rotation), side].join('|'));
    }
  }
  var digest = Digest.getInstance('SHA-256').digest(new JString(rows.sort().join('\\n')).getBytes('UTF-8'));
  var hash = '';
  for (var h = 0; h < digest.length; h++) hash += ('0' + ((digest[h] + 256) % 256).toString(16)).slice(-2);
  var home = String(System.getProperty('user.home'));
  function secret(file) { return String(new JString(Files.readAllBytes(Paths.get(home + '/.secrets/' + file)), 'UTF-8')).trim(); }
  var base = String(System.getenv('COBBLR_URL') || '').replace(/\\/$/, '');
  var workspace = String(System.getenv('COBBLR_WORKSPACE') || '');
  if (!base || !workspace) throw new Error('Set COBBLR_URL and COBBLR_WORKSPACE for this station.');
  var body = JSON.stringify({ actionId: 'builds:${operation === "start" ? "start-placement" : "finish-placement"}', args: { order_id: matched[1], side: side, station_token: secret('cobblr-assembly-station-token'), source: 'openpnp', coverage_hash: hash, confirmed_all_boards: true } });
  var connection = new URL(base + '/api/v1/orgs/' + encodeURIComponent(workspace) + '/actions/invoke').openConnection();
  connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
  connection.setRequestMethod('POST'); connection.setDoOutput(true);
  connection.setRequestProperty('Content-Type', 'application/json');
  connection.setRequestProperty('Authorization', 'Bearer ' + secret('cobblr-assembly-api-token'));
  var out = connection.getOutputStream(); out.write(new JString(body).getBytes('UTF-8')); out.close();
  if (connection.getResponseCode() !== 200) throw new Error('Cobblr refused this placement event. Check this station before continuing.');
  var reader = new (Java.type('java.io.BufferedReader'))(new (Java.type('java.io.InputStreamReader'))(connection.getInputStream(), 'UTF-8'));
  var response = '', line;
  while ((line = reader.readLine()) !== null) response += String(line);
  reader.close(); connection.disconnect();
  var result = JSON.parse(response);
  if (!result.result || !result.result.ok) throw new Error(result.result && result.result.error || 'Cobblr could not record this placement event.');
}
`;
  return [{ name: "Events/Job.Starting.js", content: script("start") }, { name: "Events/Job.Finished.js", content: script("done") }, { name: "station-binding.json", content: JSON.stringify({ machine_kind: machineKind, machine_id: machineId }, null, 2) }];
}
