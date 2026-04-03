"use client";

import { useState } from "react";

function randomToken(length: number, alphabet: string) {
  const values = crypto.getRandomValues(new Uint32Array(length));
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[values[index] % alphabet.length];
  }
  return result;
}

function generateUsername() {
  return `user_${randomToken(6, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
}

function generatePassword() {
  return [
    randomToken(4, "ABCDEFGHJKLMNPQRSTUVWXYZ"),
    randomToken(4, "abcdefghijkmnopqrstuvwxyz"),
    randomToken(3, "23456789"),
    randomToken(3, "!$%&?@#"),
  ].join("");
}

export function GeneratedCredentialsFields() {
  const [username, setUsername] = useState(generateUsername());
  const [password, setPassword] = useState(generatePassword());

  return (
    <>
      <div className="space-y-2">
        <label className="text-sm font-medium text-zinc-700">Username</label>
        <div className="flex gap-2">
          <input
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => setUsername(generateUsername())}
            className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
          >
            Genera
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-zinc-700">Password</label>
        <div className="flex gap-2">
          <input
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => setPassword(generatePassword())}
            className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
          >
            Genera
          </button>
        </div>
      </div>
    </>
  );
}
