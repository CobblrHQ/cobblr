import { z } from "zod";

/** Spaces and invisible characters draw a row with nothing on it to read or press. */
export const hasSomethingToRead = (name: string) => /[^\s­​-‏‪-‮⁠-⁤﻿]/.test(name);

/** What a person, workspace or heading is called: something to read, on one line. */
export const canBeAName = (name: string) => hasSomethingToRead(name) && !/\p{Cc}/u.test(name);

export const readableNameField = (max: number) =>
  z.string().trim().min(1).max(max).refine(canBeAName, "A name needs something to read, on one line.");
