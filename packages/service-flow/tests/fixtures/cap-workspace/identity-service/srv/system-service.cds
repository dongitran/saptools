namespace generic.identity;
service IdentityService @(path: "/IdentityService") {
  action resolveAccess(input: String) returns Boolean;
}
