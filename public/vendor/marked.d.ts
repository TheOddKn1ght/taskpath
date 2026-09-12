// The lexer subset used by Taskpath; the vendored implementation stays untouched.
export interface Token { type:string; text?:string; href?:string; tokens?:Token[]; items?:Token[]; task?:boolean; checked?:boolean }
export function lexer(source:string):Token[];
