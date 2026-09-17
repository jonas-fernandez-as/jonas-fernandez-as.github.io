export const allReports = [
  'Active','Administrator','Appointment','Archetype','Baby','Base','Blackfield','BoardLight',
  'Breach','Bruno','Builder','Certified','Cicada','Codify','Crocodile','Dancing',
  'Data','Delegate','Devvortex','Down','Driver','Explosion','Fawn','Flight',
  'Forest','Funnel','GoodGames','Ignition','Included','Jeeves','Jerry','Keeper',
  'Manage','Markup','Meow','MetaTwo','Mirage','Mongod','Netmon','Nibbles',
  'Oopsie','Outbound','Pandora','Paper','Pennyworth','Preignition','Querier',
  'Redeemer','Reset','Responder','Retro','Return','Sau','Sauna','Sea',
  'ServMon','Slonik','Sniper','SolidState','Squel','SteamCloud','Sunday','Support',
  'Synced','Tactics','Three','TwoMillion','Unified','Vaccine','VulnEscape','Writeup',
];

const startingPoint = ['Appointment','Archetype','Base','Crocodile','Dancing','Explosion','Fawn','Funnel','Ignition','Included','Markup','Mongod','Oopsie','Pennyworth','Preignition','Meow','Redeemer','Responder','Squel','Synced','Tactics','Three','Unified','Vaccine'];
const easy   = ['Active','Baby','BoardLight','Cicada','Codify','Data','Devvortex','Driver','Down','Forest','GoodGames','Jerry','Keeper','MetaTwo','Manage','Netmon','Nibbles','Pandora','Outbound','Paper','Retro','Return','Reset','Sauna','Sau','Sea','ServMon','SteamCloud','Support','Sunday','TwoMillion','VulnEscape','Writeup'];
const medium = ['Administrator','Builder','Bruno','Breach','Certified','Delegate','Jeeves','Querier','Slonik','SolidState','Sniper'];
const hard   = ['Blackfield','Flight','Mirage'];

export function getReportPath(name: string): string {
  let folder = 'Easy';
  if (startingPoint.includes(name)) folder = 'Starting%20Point';
  else if (easy.includes(name))     folder = 'Easy';
  else if (medium.includes(name))   folder = 'Medium';
  else if (hard.includes(name))     folder = 'Hard';

  let filename = name;
  if (name === 'Meow')     filename = 'REPORT%20MEOW%20HTB';
  if (name === 'Redeemer') filename = 'Redeemereport';

  return `/REPORTS/${folder}/${filename}.pdf`;
}
