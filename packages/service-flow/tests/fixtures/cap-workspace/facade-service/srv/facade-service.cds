namespace generic.facade;
service FacadeService @(path: "/FacadeService") {
  action doWork(input: String) returns String;
}
