namespace generic.rules;
service RulesService @(path: "/RulesService") {
  action checkPayload(input: String) returns Boolean;
  event PayloadChecked;
}
