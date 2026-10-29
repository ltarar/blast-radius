# blast-radius

A Claude Code plugin that shows what your branch can break, while Claude is still working on it.

[![Stars](https://img.shields.io/github/stars/ltarar/blast-radius)](https://github.com/ltarar/blast-radius/stargazers)

![blast-radius showing what a branch can break](preview.png)

After each Claude turn, and whenever you run `/blast-radius`, it looks at what
your branch removed or changed, and finds the code that will no longer work. It
looks inside the repo and in your other repos that pull it in as a gem or npm
package. Changes that can't break anything stay out of the pane.

| | Means |
| :- | :- |
| 🔴 | Will break: a class, constant or method that was removed or made private is still used, a call no longer fits its method's new arguments, a deleted JS file is still imported, or a Sidekiq worker's queued jobs will fail. |
| 🟡 | May break: an instance method changed, and code calls a method with that name. Ruby can't say for sure which class a call goes to. Or a Sidekiq worker lost `perform`, but its parent class may provide it. |
| 🟢 | Nothing in the branch breaks other code. |

It also reads changes to `package_todo.yml`, so a new Packwerk rule break shows
up before review, not after.

## Install

1. Install the plugin:

   ```
   /plugin install blast-radius --marketplace ltarar/blast-radius
   ```

2. Tell it where your repos live. Run `/plugin configure` with the id that `/plugin list`
   shows, such as `blast-radius@blast-radius`, and set **Repos folder** (only needed if
   repos aren't in `~/Repositories`).

3. Open the pane:

   ```
   /blast-radius
   ```

## Requirements

- Claude Code 2.1.294 or later
- `git` on your `PATH`
- Your repos cloned side by side in one folder

## Commands

| Command | What it does |
| :- | :- |
| `/blast-radius` | Opens the pane for the repos in focus |
| `/blast-radius <repo>...` | Adds repos to focus |
| `/blast-radius all` | Shows every repo with changes |
| `/blast-radius clear` | Clears focus back to the current repo |

A repo joins focus by itself when Claude edits a file in it. The status line carries a one-line summary.

## How it works

blast-radius compares the branch with its merge base on `origin/HEAD`,
including uncommitted and new files.

In Ruby, it reads the classes, modules, constants and public methods that the
changed files define, before and after. It then searches for code that still
uses anything that disappeared, and checks each call against a method's new
arguments, so a new optional argument stays quiet. Changes inside a method body,
a new parent class, and moves that keep a name are left out, since callers
still work.

In JS and TS, it finds deleted files that something still imports.

To find other repos that use this one, it reads the gemspec or `package.json`
name and checks every repo's `Gemfile.lock` and `package.json` for it.

It can't see calls through `send`, `described_class` or other dynamic code.
Your specs still cover those.

Everything runs locally with `git` and the files on disk. Nothing is sent
anywhere.
