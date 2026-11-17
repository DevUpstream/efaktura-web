/** Lista na edinici merka za <input list="units-dl"> (zabeleska 15): izbor od listata ili sloboden vnes. */
import { unitsOf } from "../format";

export const UNITS_DL = "units-dl";
export function UnitsList({ client }: { client: { units?: string[] } }) {
  return <datalist id={UNITS_DL}>{unitsOf(client).map((u) => <option key={u} value={u} />)}</datalist>;
}
