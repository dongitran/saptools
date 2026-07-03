namespace generic.process;
service ThingProcessService @(path: "/ThingProcessService") { action getPaths(input: String) returns String; }
