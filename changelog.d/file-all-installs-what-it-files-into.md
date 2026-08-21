---
type: fix
scope: scan
date: 2026-08-21
---
Filing a whole session now installs any table it is filing into that the workspace does not have yet. A receipt of groceries routed to the Groceries bundle failed on every line, because the sweep asked to file into a table that did not exist and the API rightly answered that it could not find it. The button's tooltip also says which table it will install, and no longer just repeats the button.
