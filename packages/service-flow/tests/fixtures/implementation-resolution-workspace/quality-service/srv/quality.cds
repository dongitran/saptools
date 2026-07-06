service QualityService {
  function runQualityCheck() returns String;
  function runDynamicCheck() returns String;
}

service ProfileService {
  function getUserScope() returns String;
}

service SystemService {
  function getUserScope() returns String;
}
