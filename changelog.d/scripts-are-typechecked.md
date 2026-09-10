---
type: fix
date: 2026-09-10
---
The repository's own tooling scripts are now typechecked like the rest of the code. They never were, which is how a script could name a variable that did not exist and only fail when that line finally ran. Fixing the backlog turned up a duplicated import, two version comparisons that misread a short version number, and a dozen places where a pattern match was used without checking it matched.
