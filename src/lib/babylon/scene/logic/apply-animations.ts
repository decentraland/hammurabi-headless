import * as BABYLON from '@babylonjs/core'
import { BabylonEntity } from "../BabylonEntity";
import { animatorComponent } from "../../../decentraland/sdk-components/animator-component";

// This function applies the specified animations to the gltf animation group
export function applyAnimations(entity: BabylonEntity) {
  const sceneContext = entity.context.deref()

  if (!sceneContext) return

  const component = sceneContext.components[animatorComponent.componentId]

  // get the new value of the animation
  const currentAnimationComponentValue = component.getOrNull(entity.entityId)

  const animationGroups = entity.appliedComponents.gltfContainer?.instancedEntries?.animationGroups || []

  if (currentAnimationComponentValue) {
    for (const animationAttributes of currentAnimationComponentValue.states) {
      // find the animation group
      let clip: BABYLON.AnimationGroup | void = animationGroups.find($ => $.name === animationAttributes.clip)

      if (clip) {
        // Omitted speed/weight default to the protocol's 1.0 (NOT "keep whatever
        // the previous PUT set"), and a non-finite scene value is clamped to 1.
        const speed = animationAttributes.speed ?? 1
        clip.speedRatio = Number.isFinite(speed) ? speed : 1

        if (animationAttributes.shouldReset) {
          clip.reset()
        }

        if (animationAttributes.playing && !(clip as any).isPlaying) {
          clip.play(animationAttributes.loop)
        } else if (!animationAttributes.playing && (clip as any).isPlaying) {
          clip.pause()
        }

        const weight = animationAttributes.weight ?? 1
        clip.setWeightForAllAnimatables(Number.isFinite(weight) ? weight : 1)
      }
    }
  } else {
    // animations must be stopped if the component was removed
    for (const animation of animationGroups) {
      animation.stop()
    }
  }
}