service SettingsService {
  action applyRules(id: String);
  function getRuleInfo(id: String) returns String;
}
