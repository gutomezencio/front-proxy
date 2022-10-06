import { resolve } from 'path'

export default dir => {
  return resolve(__dirname, '..', '../', dir)
}
