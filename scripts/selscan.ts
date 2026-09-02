/** Brute-force a candidate error-name space against an observed revert selector. */
import { toFunctionSelector } from "viem";
const target = process.argv[2].toLowerCase();
const nouns = ["Unauthorized","NotAuthorized","AccessDenied","Forbidden","MissingRole","NoRole","NotAllowed","OperationNotAllowed","CallerNotAllowed","InvalidCaller","InvalidSender","SenderNotAllowed","UnauthorizedAccount","AccountUnauthorized","NotPermitted","PermissionDenied","OnlyAdmin","OnlyOwner","NotOwner","NotAdmin","NotManager","NotVault","NotRole","RoleMissing","AccessControlUnauthorized","AccessManagedUnauthorized","AccessManagerUnauthorized","Unauthorised","UnauthorizedSender","UnauthorizedCaller","CallerUnauthorized","SenderUnauthorized","AuthFailed","AuthError","NotAuthorised"];
const argsets = [["address","bytes32"],["address","uint256"],["address","address"],["address","bytes4"],["address","uint8"],["address","bool"]];
for (const n of nouns) for (const a of argsets) {
  const sig = `${n}(${a.join(",")})`;
  if (toFunctionSelector(sig).toLowerCase() === target) console.log("MATCH", sig);
}
console.log("scan complete:", nouns.length * argsets.length, "candidates");
