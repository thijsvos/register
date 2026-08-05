import './styles/tokens.css'
import './styles/base.css'
import { mount } from 'svelte'
import { measure } from './lib/render.svelte'
import App from './ui/App.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('#app is missing from index.html')

// Boot is bracketed from out here so the first RENDER readout includes the cost
// of building the frame, not just of the state change that follows it.
export default measure(() => mount(App, { target }))
