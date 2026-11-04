/** Spaces and invisible characters draw a row with nothing on it to read or press. */
export const hasSomethingToRead = (name: string) => /[^\s­​-‏‪-‮⁠-⁤﻿]/.test(name);
